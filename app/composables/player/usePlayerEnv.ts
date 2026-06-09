// app/composables/player/usePlayerEnv.ts
//
// Player-environment shim. `fileUrl` returns the normal server media path on
// every platform.
// When a media base is configured (MEDIA_PUBLIC_BASE → runtimeConfig.public.mediaPublicBase), fileUrl returns an absolute CDN URL instead; an empty base falls back to the relative /media/<sha> path.
// The APK caches these `/media/<sha>` requests transparently
// at the native layer (LankaWebViewClient.shouldInterceptRequest → MediaCache),
// so no per-platform URL swap is needed here — the same code runs in the
// kiosk WebView and in a desktop browser for QA.

export interface PlayerEnv {
  fileUrl(sha256: string): string
}

export function usePlayerEnv(mediaBase = ''): PlayerEnv {
  return {
    fileUrl(sha256: string): string {
      // R2Store keys full media under the `media/` prefix (server/services/r2-store.ts),
      // and the server proxy route is `/media/<sha>` — so both the CDN and the
      // fallback paths must include the `/media/` segment.
      return mediaBase ? `${mediaBase.replace(/\/$/, '')}/media/${sha256}` : `/media/${sha256}`
    }
  }
}
