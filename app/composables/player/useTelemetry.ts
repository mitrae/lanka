// app/composables/player/useTelemetry.ts
import type { ApiClient } from '~/app/composables/useApiClient'

export interface Telemetry {
  itemStarted(deviceId: string, currentItemId: number): void
  itemFailed(
    deviceId: string,
    currentItemId: number | null,
    sha256: string | undefined,
    message: string
  ): void
  clearedCurrent(deviceId: string): void
}

/**
 * Fire-and-forget telemetry. Each call returns synchronously; the POST
 * runs in the background. Failures are swallowed after a console.warn
 * because the player must keep playing even if telemetry is unreachable.
 */
export function useTelemetry(api: ApiClient): Telemetry {
  function fire(
    deviceId: string,
    body: {
      currentItemId: number | null
      error?: { sha256?: string; message: string }
    }
  ): void {
    const nfs = (globalThis as any).NativeFS
    const apkVersion: string | undefined = nfs?.getAppVersion?.()
    api.postTelemetry(deviceId, { ...body, ...(apkVersion ? { apkVersion } : {}) }).catch((err) => {
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
    }
  }
}
