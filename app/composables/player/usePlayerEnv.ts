// app/composables/player/usePlayerEnv.ts
//
// Player-environment shim. `fileUrl` returns the normal server media path on
// every platform. The APK caches these `/media/<sha>` requests transparently
// at the native layer (LankaWebViewClient.shouldInterceptRequest → MediaCache),
// so no per-platform URL swap is needed here — the same code runs in the
// kiosk WebView and in a desktop browser for QA.

export interface PlayerEnv {
  fileUrl(sha256: string): string
}

export function usePlayerEnv(mediaBase = ''): PlayerEnv {
  return {
    fileUrl(sha256: string): string {
      return mediaBase ? `${mediaBase}/${sha256}` : `/media/${sha256}`
    }
  }
}
