// app/composables/player/fetchBlobUrl.ts
//
// Same-origin blob fallback, shared by PlayerStage and InterruptOverlay.
//
// Why it exists: on at least one TV (Haier, Chrome 152 WebView) the media
// pipeline rejects the APK interceptor's cached response outright, while
// fetch() reads the same bytes happily. The fetch MUST stay same-origin — an
// intercepted response carries no CORS headers, so a CDN URL would fail.
export async function fetchBlobUrl(sha256: string): Promise<string> {
  const res = await fetch(`/media/${sha256}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return URL.createObjectURL(await res.blob())
}
