// app/composables/player/usePlayerEnv.ts
//
// Player-environment shim.
// Priority: NativeFS local cache (Android APK) > CDN URL > relative server path.
// When window.NativeFS is present (injected by NativeFSBridge.kt) and the file
// is already cached on-device, fileUrl returns a file:// URI served directly
// from disk — no network needed. Otherwise falls back to the CDN/server URL.
// The APK's transparent interceptor (LankaWebViewClient → MediaCache) also
// caches /media/<sha> requests as a background safety net for the CDN path.

export interface PlayerEnv {
  fileUrl(sha256: string): string
}

export function usePlayerEnv(mediaBase = ''): PlayerEnv {
  return {
    fileUrl(sha256: string): string {
      // NativeFS bridge injected by the Android APK (NativeFSBridge.kt).
      // globalThis works in both browser (=== window) and Vitest (Node).
      const nativeFs = (globalThis as any).NativeFS
      if (nativeFs?.exists(sha256)) return nativeFs.fileUrl(sha256) as string
      // R2Store keys full media under the `media/` prefix (server/services/r2-store.ts),
      // and the server proxy route is `/media/<sha>` — so both the CDN and the
      // fallback paths must include the `/media/` segment.
      return mediaBase ? `${mediaBase.replace(/\/$/, '')}/media/${sha256}` : `/media/${sha256}`
    }
  }
}
