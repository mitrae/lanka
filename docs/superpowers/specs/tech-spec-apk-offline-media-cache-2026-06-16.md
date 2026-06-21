# Technical Specification: APK Offline Media Cache (Plan 6)

**Date:** 2026-06-16
**Author:** dmytro
**Version:** 1.0
**Project Type:** Feature — Android APK + Nuxt player
**Project Level:** Level 1 (5 stories)
**Status:** Draft

---

## Document Overview

This spec covers Plan 6 of the Lanka roadmap: on-device media caching in the Android kiosk APK. The `:bridge` Gradle module stub was reserved in Plan 5 specifically for this work.

**Related Documents:**
- APK kiosk design (Plan 5): `docs/superpowers/specs/2026-04-19-lanka-apk-kiosk-design.md`
- Player design: `docs/superpowers/specs/2026-04-18-lanka-player-design.md`

---

## Problem & Solution

### Problem Statement

The Lanka player currently streams all media directly from the R2 CDN (`media.lanka.live`). TVs in locations with unstable or slow internet connections experience stuttering, blank screens, or failed playback. Any internet interruption stops the show entirely — unacceptable for signage.

### Proposed Solution

Add a native media downloader to the Android APK. Before playing, the reconciler downloads each media file to app-local storage via a `NativeFS` JavaScript bridge. Once cached, the player uses `file://` local URLs instead of CDN URLs, making playback fully independent of internet connectivity after the initial sync.

---

## Requirements

### What Needs to Be Built

- **NativeFS bridge**: APK injects `window.NativeFS` into the WebView with five methods: `exists(sha256)`, `download(sha256, url)`, `fileUrl(sha256)`, `evictExcept(sha256Array)`, `free()`.
- **Media downloader**: Kotlin coroutine-based downloader that fetches bytes from a given URL and writes to `{filesDir}/media/{sha256}` atomically (write to `.tmp`, rename on success).
- **Eviction**: `evictExcept(sha256Array)` deletes cached files whose sha256 is not in the current manifest — prevents unbounded storage growth.
- **Player integration (`usePlayerEnv`)**: `fileUrl(sha256)` checks `window.NativeFS?.exists(sha256)` first; returns `window.NativeFS.fileUrl(sha256)` if present, falls back to CDN URL otherwise.
- **Reconciler integration (`useReconciler`)**: Before rebuilding the playlist, for each media item call `download()` if `exists()` returns false. Show a "Syncing…" overlay during this phase. Only after all items are cached (or confirmed present), rebuild and start playback.

### What This Does NOT Include

- Audio unmute (still deferred — a separate concern).
- OTA APK updates.
- Server-side upload transcoding (noted as a future need in CLAUDE.md).
- Download progress bar per file (syncing overlay is binary — syncing vs. ready).
- Streaming/partial playback while downloading (always wait for complete file).
- Cache for the Chromium/Pi kiosk path (browser `Cache API` / service worker — separate effort).
- Download quota limits or user-configurable cache size (eviction by manifest is sufficient for v1).

---

## Technical Approach

### Technology Stack

- **Android (`:bridge` module):** Kotlin, coroutines (`kotlinx.coroutines`), `java.net.HttpURLConnection` for downloads (no extra dep; OkHttp is not yet in the project)
- **Storage:** `context.filesDir/media/` — internal private storage, no permissions needed
- **Bridge mechanism:** `WebView.addJavascriptInterface` + `@JavascriptInterface` annotations (existing pattern from `NativeDeviceBridge`)
- **Player side:** TypeScript, Vue 3, existing `usePlayerEnv.ts` + `useReconciler.ts` composables
- **Tests:** JUnit 4 (APK), Vitest (player)

### Architecture Overview

```
                    Internet up                   Internet down
                         │                              │
Manifest fetch ──────────┤                              │
(still needs net once)   │                              │
                         ▼                              ▼
              useReconciler.ts
              ┌──────────────────────────────────────────┐
              │ for each item in manifest:               │
              │   if !NativeFS.exists(sha256):           │
              │     NativeFS.download(sha256, cdnUrl)    │  ← blocks until done
              │ show "Syncing…" overlay during this      │
              └──────────────────────────────────────────┘
                         │ all cached
                         ▼
              usePlayerEnv.fileUrl(sha256)
                → NativeFS.fileUrl(sha256)   ← file:///data/.../media/{sha256}
                → plays from LOCAL STORAGE — no internet needed

              On manifest change (SSE kick):
                - reconciler re-runs
                - downloads new items
                - NativeFS.evictExcept(newSha256List) removes stale files
```

### Data Model

No new DB tables. Files stored flat:

```
{context.filesDir}/media/
  {sha256_hex}          ← complete cached file, ready to serve
  {sha256_hex}.tmp      ← in-progress download (cleaned up on failure/restart)
```

On APK startup, `MediaFileStore.init()` deletes any `.tmp` files left by a previous crashed download.

### NativeFS JavaScript Interface Contract

```typescript
interface NativeFS {
  // Returns true if sha256 is fully cached on disk.
  exists(sha256: string): boolean

  // Downloads url to local cache under sha256 key.
  // Blocks until download completes or throws on failure.
  // Safe to call if already cached (no-op).
  download(sha256: string, url: string): void

  // Returns a file:// URI the WebView can load directly.
  // Only valid after exists() returns true.
  fileUrl(sha256: string): string

  // Deletes all cached files whose sha256 is NOT in the provided list.
  // Call after reconciler finishes with the current manifest's sha256 set.
  evictExcept(sha256List: string[]): void

  // Returns available bytes in internal storage (via StatFs).
  free(): number
}
```

`@JavascriptInterface` methods run on a background JS thread — blocking in `download()` is safe and keeps the JS bridge simple. The "Syncing…" overlay is rendered natively before the download loop starts.

### Kotlin implementation sketch (`:bridge` module)

```kotlin
class NativeFSBridge(private val ctx: Context) {

  private val mediaDir = File(ctx.filesDir, "media").also { it.mkdirs() }

  @JavascriptInterface
  fun exists(sha256: String): Boolean = file(sha256).exists()

  @JavascriptInterface
  fun download(sha256: String, url: String) {
    if (exists(sha256)) return
    val tmp = File(mediaDir, "$sha256.tmp")
    try {
      val conn = URL(url).openConnection() as HttpURLConnection
      conn.connect()
      tmp.outputStream().use { out -> conn.inputStream.use { it.copyTo(out) } }
      tmp.renameTo(file(sha256))
    } catch (e: Exception) {
      tmp.delete()
      throw RuntimeException("Download failed for $sha256: ${e.message}", e)
    }
  }

  @JavascriptInterface
  fun fileUrl(sha256: String): String = "file://${file(sha256).absolutePath}"

  @JavascriptInterface
  fun evictExcept(sha256ListJson: String) {
    val keep = JSONArray(sha256ListJson).let { arr ->
      (0 until arr.length()).map { arr.getString(it) }.toSet()
    }
    mediaDir.listFiles()
      ?.filter { !it.name.endsWith(".tmp") && it.name !in keep }
      ?.forEach { it.delete() }
  }

  @JavascriptInterface
  fun free(): Long = StatFs(mediaDir.path).availableBytes

  private fun file(sha256: String) = File(mediaDir, sha256)
}
```

Note: `evictExcept` receives a JSON array string because `@JavascriptInterface` only supports primitive types and `String`.

### Player-side changes (`usePlayerEnv.ts`)

```typescript
// Before (Plan 5):
fileUrl: (sha256: string) => `${mediaPublicBase}/${sha256}`

// After (Plan 6):
fileUrl: (sha256: string) => {
  const nativeFs = (window as any).NativeFS
  if (nativeFs?.exists(sha256)) return nativeFs.fileUrl(sha256)
  return `${mediaPublicBase}/${sha256}`
}
```

### Reconciler changes (`useReconciler.ts`)

Before `buildPlaylist()`:
1. Collect all `sha256` values from the incoming manifest items.
2. For each sha256 where `NativeFS.exists()` is false: call `NativeFS.download(sha256, cdnUrl)`.
3. After all downloads complete: call `NativeFS.evictExcept(currentSha256List)`.
4. Call `buildPlaylist()` — `fileUrl()` now returns local paths.

The "Syncing…" overlay is shown during step 2 (existing `<StandbyScreen>` can be reused with a status prop).

---

## Implementation Plan

### Stories

1. **NativeFSBridge scaffold** — Implement `:bridge` module with `NativeFSBridge` (exists, fileUrl, evictExcept, free), inject into WebView in `MainActivity`, clean up `.tmp` files on init. No download yet.
2. **MediaDownloader** — Implement `download()` in `NativeFSBridge` with atomic write (`.tmp` → rename). Unit-test success, failure cleanup, and no-op when already cached.
3. **Player `fileUrl` integration** — Update `usePlayerEnv.fileUrl` to check `window.NativeFS.exists` and return local URL. Vitest coverage for both branches (NativeFS present vs. absent).
4. **Reconciler sync loop** — Update `useReconciler.ts` to call `download()` for uncached items before `buildPlaylist()`, call `evictExcept()` after, show syncing overlay during. Vitest coverage.
5. **Manual QA & storage guard** — `free()` check before download: if available bytes < file size (from `Content-Length` header), skip download and log warning. End-to-end QA on device.

### Development Phases

- **Phase A (Stories 1–2):** APK-only, no player changes. Validate file storage and download on-device via `adb shell` inspection.
- **Phase B (Stories 3–4):** Player integration. Test against dev server with APK that has the bridge.
- **Phase C (Story 5):** Hardening. Storage guard, manual QA checklist, sign-off.

---

## Acceptance Criteria

- [ ] APK injects `window.NativeFS` — `typeof window.NativeFS !== 'undefined'` in WebView console
- [ ] After first manifest load, all media files appear under `{filesDir}/media/` on-device (`adb shell ls`)
- [ ] Player plays without any CDN requests after initial sync (verified via `adb shell` network stats or turning off WiFi)
- [ ] After playlist change, new files downloaded, old files evicted
- [ ] Playback continues normally when device WiFi is disabled (after sync)
- [ ] No `.tmp` files left after a clean download sequence
- [ ] `.tmp` files cleaned up on APK restart after a simulated crash mid-download
- [ ] All unit tests pass (`./gradlew test`)
- [ ] All Vitest tests pass (`pnpm test`)
- [ ] `free()` returns a plausible byte count (sanity check in QA)

---

## Non-Functional Requirements

### Performance

- Download happens before playback (sync phase); first-play after manifest change is delayed by download time. Acceptable — syncing overlay communicates state.
- `evictExcept` runs synchronously after downloads; must complete in < 1s for typical playlist sizes (< 50 items).
- No impact on playback performance — once cached, all I/O is local.

### Security

- Files stored in `context.filesDir` — private to the APK, no `READ_EXTERNAL_STORAGE` permission needed.
- CDN URLs come from the manifest served by Lanka server over the tailnet — operator-controlled, not user-supplied.
- `evictExcept` only deletes files in `mediaDir` — no path traversal risk since sha256 is hex-only.

### Other

- `minSdk 24` compatible — `StatFs.getAvailableBytes()` available since API 18.
- `HttpURLConnection` is available on all Android versions — no extra dependency.

---

## Dependencies

- Plan 5 APK fully merged and working (`:bridge` stub module exists).
- Lanka server's manifest API returns sha256 per media item (already the case — content-addressed by sha256).
- R2 CDN media URLs accessible from the TV during the sync phase (internet needed for first download; after that, offline).
- `usePlayerEnv.fileUrl` composable exists (Plan 5, shipped).
- `useReconciler.ts` composable exists (Plan 3/5, shipped).

---

## Risks & Mitigation

- **Risk:** Download blocks JS thread for large files, causing WebView ANR.
  - **Mitigation:** `@JavascriptInterface` runs on a dedicated thread, not the main UI thread. Android won't ANR on it. The WebView's main thread continues to render the syncing overlay. Keep files small per CLAUDE.md guidance (≤480–720p H.264, faststart). Server-side transcoding remains the long-term fix.

- **Risk:** Internal storage fills up on devices with small `/data` partitions.
  - **Mitigation:** `free()` check before each download in Story 5. Log warning and skip if insufficient space; player falls back to CDN URL for that file. Dashboard should surface storage warnings in a future iteration.

- **Risk:** Partial/corrupt download served to player.
  - **Mitigation:** Atomic write (`.tmp` → rename). `exists()` only returns true for the final non-`.tmp` path.

- **Risk:** `evictExcept` is called with a JSON string because `@JavascriptInterface` doesn't accept arrays.
  - **Mitigation:** Thin TypeScript wrapper in `usePlayerEnv` serializes the array with `JSON.stringify` before calling the bridge. Well-tested in Vitest.

---

## Timeline

**Target Completion:** No hard deadline — prototype pace.

**Milestones:**
- Phase A (bridge + downloader): 1–2 days
- Phase B (player integration): 1 day
- Phase C (hardening + QA): 1 day

---

## Approval

**Reviewed By:**
- [ ] dmytro (Author)

---

**This document was created using BMAD Method v6 - Phase 2 (Planning)**

*Next: Run `/sprint-planning` to organize stories, or `/dev-story` to start Story 1.*
