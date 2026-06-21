// app/composables/player/usePlayerBoot.ts
//
// Top-level orchestrator for the /player route. Glues reconciler +
// scheduler + telemetry + native-device. Exposes reactive state that
// app/pages/player.vue renders.
import { onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { useNativeDevice, PLAYER_VERSION } from './useNativeDevice'
import { usePlayerEnv, type PlayerEnv } from './usePlayerEnv'
import { useTelemetry } from './useTelemetry'
import {
  createReconciler,
  type NativeFSBridge,
  type ReconcilerHandle,
  type StreamState
} from './useReconciler'
import { createCommandChannel, type CommandChannelHandle } from './useCommandChannel'
import {
  createPlayerScheduler,
  type SchedulerHandle
} from './createPlayerScheduler'

export type PlayerScreen = 'booting' | 'standby' | 'no-content' | 'playing'

export interface PlayerBootState {
  screen: Ref<PlayerScreen>
  streamState: Ref<StreamState>
  manifest: ShallowRef<Manifest | null>
  scheduler: ShallowRef<SchedulerHandle | null>
  env: PlayerEnv
  deviceId: Ref<string>
  lastError: Ref<string | null>
  /** True while the NativeFS bridge is pre-downloading media for a new playlist. */
  syncing: Ref<boolean>
}

export function usePlayerBoot(
  apiOverride?: ApiClient
): PlayerBootState {
  const api = apiOverride ?? useApiClient()
  const device = useNativeDevice()
  const env = usePlayerEnv(useRuntimeConfig().public.mediaPublicBase)
  const telemetry = useTelemetry(api)

  const deviceId = ref(device.deviceId())
  const screen = ref<PlayerScreen>('booting')
  const streamState = ref<StreamState>('disconnected')
  const manifest = shallowRef<Manifest | null>(null)
  const scheduler = shallowRef<SchedulerHandle | null>(null)
  const lastError = ref<string | null>(null)
  const syncing = ref(false)

  let reconciler: ReconcilerHandle | null = null
  let channel: CommandChannelHandle | null = null

  function mountScheduler(m: Manifest): void {
    // Tear down any existing scheduler first so its timers are cancelled.
    scheduler.value?.stop()

    const sched = createPlayerScheduler(m.items, {
      now: () => Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (h) => window.clearTimeout(h as number)
    })

    sched.onItemStart((index) => {
      const item = m.items[index]
      if (!item) return
      telemetry.itemStarted(deviceId.value, item.id)
    })
    sched.onItemError((index, msg) => {
      const item = m.items[index]
      telemetry.itemFailed(
        deviceId.value,
        item?.id ?? null,
        item?.sha256,
        msg
      )
    })

    scheduler.value = sched
    sched.start()
  }

  async function ensureRegistered(): Promise<void> {
    try {
      await api.register({
        deviceId: deviceId.value,
        playerVersion: PLAYER_VERSION
      })
    } catch (err) {
      console.warn('[player] register failed; will retry on next reconcile error', err)
    }
  }

  async function boot(): Promise<void> {
    await ensureRegistered()

    const mediaBase = useRuntimeConfig().public.mediaPublicBase as string
    const nativeFS = (globalThis as any).NativeFS as NativeFSBridge | undefined
    const cdnUrl = nativeFS
      ? (sha256: string) => mediaBase
        ? `${mediaBase.replace(/\/$/, '')}/media/${sha256}`
        : `/media/${sha256}`
      : undefined

    reconciler = createReconciler({
      api,
      deviceId: deviceId.value,
      nativeFS,
      cdnUrl,
      onReload: () => device.reload()
    })

    reconciler.onManifest((m) => {
      lastError.value = null
      manifest.value = m
      if (m === null) {
        scheduler.value?.stop()
        scheduler.value = null
        screen.value = 'no-content'
        telemetry.clearedCurrent(deviceId.value)
        return
      }
      mountScheduler(m)
      screen.value = 'playing'
    })
    reconciler.onSyncing((s) => {
      syncing.value = s
    })
    reconciler.onError((e) => {
      lastError.value = e instanceof Error ? e.message : String(e)
      // Only fall back to standby if we've never played anything yet.
      if (manifest.value === null) {
        screen.value = 'standby'
        // A failed boot-time register leaves the server with no row for this
        // device, so every manifest fetch 404s forever and the screen is stuck
        // on standby. Re-register (idempotent upsert) so the reconciler's next
        // retry can succeed instead of stranding the box.
        void ensureRegistered()
      }
    })

    // Poll the stream-state ref each event loop tick; cheap and works
    // without reactive wrapping inside createReconciler.
    const stateTimer = window.setInterval(() => {
      if (reconciler) streamState.value = reconciler.getStreamState()
    }, 500)

    onBeforeUnmount(() => {
      window.clearInterval(stateTimer)
    })

    await reconciler.reconcile()
    reconciler.openStream()
    reconciler.startPolling()

    channel = createCommandChannel({
      deviceId: deviceId.value,
      nativeFS,
      onReload: () => device.reload()
    })
    channel.open()
  }

  void boot()

  onBeforeUnmount(() => {
    scheduler.value?.stop()
    scheduler.value = null
    reconciler?.close()
    reconciler = null
    channel?.close()
    channel = null
  })

  return {
    screen,
    streamState,
    manifest,
    scheduler,
    env,
    deviceId,
    lastError,
    syncing
  }
}
