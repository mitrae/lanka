// app/composables/player/useNativeDevice.ts
//
// Web shim for the NativeDevice contract from the parent spec. Plan 5
// (Android APK) will replace this by detecting `window.nativeDevice` and
// delegating; in Plan 3 we always use the web flow.
import { resolveDeviceId } from './resolveDeviceId'

export const PLAYER_VERSION = '3.0.0-web'

export interface NativeDevice {
  deviceId(): string
  reload(): void
  version(): { app: string; os: string; model: string }
  serverUrl(): string
}

let _cachedId: string | null = null

function getQueryDeviceId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  return params.get('deviceId') ?? undefined
}

function getStorage() {
  // Matches the DeviceIdStorage interface required by resolveDeviceId.
  if (typeof window === 'undefined') {
    return {
      get: () => null,
      set: () => {
        /* noop in SSR — player is client-only, so this path is dead code */
      }
    }
  }
  return {
    get: (k: string) => window.localStorage.getItem(k),
    set: (k: string, v: string) => window.localStorage.setItem(k, v)
  }
}

export function useNativeDevice(): NativeDevice {
  return {
    deviceId() {
      if (_cachedId) return _cachedId
      _cachedId = resolveDeviceId({
        query: getQueryDeviceId(),
        storage: getStorage(),
        generate: () => crypto.randomUUID()
      })
      return _cachedId
    },
    reload() {
      if (typeof window !== 'undefined') window.location.reload()
    },
    version() {
      return {
        app: PLAYER_VERSION,
        os: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        model: 'Browser'
      }
    },
    serverUrl() {
      return typeof window !== 'undefined' ? window.location.origin : ''
    }
  }
}

// Test-only helper — lets unit tests wipe the cached id between runs.
export function _resetNativeDeviceCache(): void {
  _cachedId = null
}
