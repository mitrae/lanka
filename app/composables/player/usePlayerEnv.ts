// app/composables/player/usePlayerEnv.ts
//
// Player-environment shim. In Plan 3 we serve media directly from the
// Nuxt server; in Plan 5 the APK's WebViewAssetLoader exposes cached
// files at https://appassets.androidplatform.net/media/<sha> and this
// composable's `fileUrl` implementation will be swapped accordingly.

export interface PlayerEnv {
  fileUrl(sha256: string): string
}

export function usePlayerEnv(): PlayerEnv {
  return {
    fileUrl(sha256: string): string {
      return `/media/${sha256}`
    }
  }
}
