// app/composables/player/usePlayerEnv.ts
//
// Player-environment shim — resolves the URL for a content-addressed media file.
//
// Always returns the http(s) `/media/<sha>` URL (relative, or under the CDN
// media base). On the Android APK the bytes are still served WITHOUT network:
// the WebView's shouldInterceptRequest cache-aside interceptor (LankaWebViewClient
// → MediaCache) matches `/media/<sha>`, serves the pre-downloaded local file with
// the correct Content-Type + HTTP Range, and only falls through to the network on
// a cache miss. Pre-download happens via NativeFS.download in the reconciler.
//
// We deliberately do NOT return a `file://` URL even when NativeFS reports the
// file cached: the player document is served over http://, and an http-origin
// page is forbidden from loading file:// resources — Android WebView rejects it
// with "Not allowed to load local resource", so a file:// <video> src never
// plays. The interceptor is the only working offline path.

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
