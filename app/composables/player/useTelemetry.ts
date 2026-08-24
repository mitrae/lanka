// app/composables/player/useTelemetry.ts
import type { ApiClient } from '~/app/composables/useApiClient'
import { PLAYER_SURFACE } from './useNativeDevice'
import type { VisibilityHandle } from './useVisibility'

export interface Telemetry {
  itemStarted(deviceId: string, currentItemId: number): void
  itemFailed(
    deviceId: string,
    currentItemId: number | null,
    sha256: string | undefined,
    message: string
  ): void
  clearedCurrent(deviceId: string): void
  /** Periodic proof-of-life carrying on-screen state. Sends NO currentItemId,
   *  so the server neither counts a play nor disturbs the current item. */
  heartbeat(deviceId: string): void
}

/**
 * Fire-and-forget telemetry. Each call returns synchronously; the POST
 * runs in the background. Failures are swallowed after a console.warn
 * because the player must keep playing even if telemetry is unreachable.
 *
 * Visibility is attached HERE, to every post, rather than being threaded
 * through each call site — so a state change is reflected at the next play
 * start without waiting for the heartbeat, and no future caller can forget it.
 */
export function useTelemetry(api: ApiClient, visibility?: VisibilityHandle): Telemetry {
  function fire(
    deviceId: string,
    body: {
      currentItemId?: number | null
      error?: { sha256?: string; message: string }
    }
  ): void {
    const nfs = (globalThis as any).NativeFS
    const apkVersion: string | undefined = nfs?.getAppVersion?.()
    const vis = visibility?.snapshot()
    api.postTelemetry(deviceId, {
      ...body,
      surface: PLAYER_SURFACE,
      ...(apkVersion ? { apkVersion } : {}),
      ...(vis
        ? {
            visibility: vis.visibility,
            foregroundPackage: vis.foregroundPackage,
            snapBacks: vis.snapBacks,
            focusLosses: vis.focusLosses,
            hiddenMs: vis.hiddenMs
          }
        : {})
    }).catch((err) => {
      console.warn('[player] telemetry post failed', err)
    })
  }
  return {
    itemStarted(deviceId, currentItemId) {
      fire(deviceId, { currentItemId })
    },
    itemFailed(deviceId, currentItemId, sha256, message) {
      fire(deviceId, {
        currentItemId,
        error: { sha256, message }
      })
    },
    clearedCurrent(deviceId) {
      fire(deviceId, { currentItemId: null })
    },
    heartbeat(deviceId) {
      fire(deviceId, {})
    }
  }
}
