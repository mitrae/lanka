// app/composables/player/usePlayerBoot.ts
//
// Top-level orchestrator for the /player route. Glues reconciler +
// scheduler + telemetry + native-device. Exposes reactive state that
// app/pages/player.vue renders.
import { onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { useNativeDevice, PLAYER_VERSION, PLAYER_SURFACE } from './useNativeDevice'
import { usePlayerEnv, type PlayerEnv } from './usePlayerEnv'
import { useTelemetry } from './useTelemetry'
import { createVisibility, shouldPost, type VisibilityHandle } from './useVisibility'
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

/** Injected by vite.define (nuxt.config.ts); absent under vitest. */
declare const __LANKA_BUILD__: string | undefined
/** localStorage key remembering which server build we last reloaded for. */
const RELOAD_GUARD_KEY = 'lanka.reloadedForBuild'

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
  // Created BEFORE the first reconcile so the very first play start is already
  // enriched, and handed to useTelemetry so every post carries visibility.
  const visibility: VisibilityHandle = createVisibility({
    nativeFS: (globalThis as any).NativeFS
  })
  const telemetry = useTelemetry(api, visibility)

  const deviceId = ref(device.deviceId())
  const screen = ref<PlayerScreen>('booting')
  const streamState = ref<StreamState>('disconnected')
  const manifest = shallowRef<Manifest | null>(null)
  const scheduler = shallowRef<SchedulerHandle | null>(null)
  const lastError = ref<string | null>(null)
  const syncing = ref(false)

  let reconciler: ReconcilerHandle | null = null
  let channel: CommandChannelHandle | null = null
  let sampleTimer: number | null = null
  // boot() is async but onBeforeUnmount is registered synchronously; without
  // this flag an unmount during an await leaves resources created afterwards
  // running forever.
  let disposed = false

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

  // The command-channel secret is returned by /register only on the FIRST
  // registration (TOFU), so persist it in localStorage (survives WebView
  // reloads/reboots) and reuse it on every later boot.
  const secretKey = (id: string) => `lanka:cmd-secret:${id}`
  function loadSecret(id: string): string | null {
    try {
      return globalThis.localStorage?.getItem(secretKey(id)) ?? null
    } catch {
      return null
    }
  }
  function saveSecret(id: string, secret: string): void {
    try {
      globalThis.localStorage?.setItem(secretKey(id), secret)
    } catch {
      /* private mode / no storage — the WS just stays in grace mode */
    }
  }

  async function ensureRegistered(): Promise<void> {
    try {
      const res = await api.register({
        deviceId: deviceId.value,
        playerVersion: PLAYER_VERSION,
        surface: PLAYER_SURFACE
      })
      if (res?.commandSecret) saveSecret(deviceId.value, res.commandSecret)
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
      bundleBuild: typeof __LANKA_BUILD__ === 'string' ? __LANKA_BUILD__ : undefined,
      reloadGuard: {
        get: () => { try { return localStorage.getItem(RELOAD_GUARD_KEY) } catch { return null } },
        set: (b) => { try { localStorage.setItem(RELOAD_GUARD_KEY, b) } catch { /* private mode */ } }
      },
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
      secret: loadSecret(deviceId.value),
      nativeFS,
      onReload: () => device.reload()
    })
    channel.open()

    if (disposed) return
    let lastSeq = -1
    let lastPostAt = 0
    // Sample cheaply and post on a real change, with the heartbeat as a floor.
    // A 30 s beat alone would miss an occlusion that starts and ends between
    // two beats: the state is only promoted inside snapshot().
    sampleTimer = window.setInterval(() => {
      const snap = visibility.snapshot()
      const elapsed = Date.now() - lastPostAt
      if (!shouldPost(snap.changeSeq, lastSeq, elapsed)) return
      lastSeq = snap.changeSeq
      lastPostAt = Date.now()
      telemetry.heartbeat(deviceId.value)
    }, 2_000)
  }

  void boot()

  onBeforeUnmount(() => {
    disposed = true
    scheduler.value?.stop()
    scheduler.value = null
    reconciler?.close()
    reconciler = null
    channel?.close()
    channel = null
    if (sampleTimer !== null) {
      window.clearInterval(sampleTimer)
      sampleTimer = null
    }
    visibility.stop()
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
