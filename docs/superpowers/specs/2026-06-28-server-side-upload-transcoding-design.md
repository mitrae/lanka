# Technical Specification: Server-Side Upload Transcoding

**Date:** 2026-06-28
**Author:** dmytro
**Version:** 1.0
**Project Type:** Feature — Nitro server (media upload pipeline)
**Project Level:** Level 1 (5 stories)
**Status:** Draft

---

## Document Overview

Normalize every uploaded video on the server to a kiosk-safe encoding profile, so any clip a user uploads plays on the Android TV fleet without manual transcoding.

**Related Documents:**
- Offline media cache (Plan 6): `docs/superpowers/specs/tech-spec-apk-offline-media-cache-2026-06-16.md`
- Now-playing / media detail: `docs/superpowers/specs/2026-06-14-dashboard-now-playing-media-detail-play-counts-design.md`
- Memory: `webview-h264-high-profile-fails`, `fleet-hardware-direction`

---

## Problem & Solution

### Problem Statement

Uploaded media is stored and served byte-for-byte as uploaded. The kiosk runs the player in an Android **WebView**, whose HTML5 `<video>` is far pickier than the box's hardware decoder. Verified on the Xiaomi TV Box S 3rd Gen (Amlogic S905X5M):

- **H.264 High profile does NOT play** in the WebView (shows the play-button placeholder, `video.error.code = 4`). H.264 **Main / Baseline** plays. The Amlogic hardware decodes High fine in native apps — the limit is the WebView media path.
- Oversized clips (e.g. 103 MB, or high bitrate) strain low-RAM (2 GB) boxes.
- Until 2026-06-27, R2 objects were also stored with an **empty `Content-Type`**, which the `<video>` rejects; that upload bug is now fixed separately (`R2Store` sets Content-Type).

The net effect: a large fraction of real-world uploads (phone videos, Telegram clips — typically H.264 **High**) silently fail to play, showing a placeholder. Today the only fix is to hand-transcode each clip with `ffmpeg` before uploading. This does not scale to a ~50-TV fleet operated by non-technical users.

### Proposed Solution

Add a transcoding step to the media upload pipeline. On upload, **probe** the video; if it already conforms to the kiosk-safe profile, store it unchanged; otherwise **transcode** it to H.264 Main / yuv420p / ≤720p / faststart / AAC before storing. Media stays content-addressed by the sha256 of the **served** (post-transcode) file. The server already bundles `ffmpeg` (used for thumbnails), so no new system dependency is required.

---

## Requirements

### What Needs to Be Built

- **Probe step** — `ffprobe` the uploaded video and read codec, profile, pixel format, width, height, duration, and audio codec.
- **Conformance check** — decide whether the clip is already kiosk-safe (skip transcode) or must be transcoded.
- **Transcode step** — `ffmpeg` re-encode non-conforming videos to the kiosk-safe profile (below), to a temp file.
- **Pipeline rewrite (`media.post.ts`)** — upload → temp file → probe → (transcode if needed) → hash the **final** file → dedup → `store.put(finalSha, …, 'video/mp4')` → thumbnail (from final file) → insert media row with the final sha + ffprobe-derived `width`/`height`/`duration_ms`.
- **Source dedup** — re-uploading the same source must not re-transcode; track the source sha256.
- **Failure handling** — if transcode fails, reject the upload with a clear 422 (do not store an unplayable file).

### Kiosk-safe profile (the target)

| Property | Value |
|---|---|
| Container | MP4, `+faststart` (moov at front) |
| Video codec | H.264 (`libx264`) |
| Profile | **Main** (Baseline also acceptable; **never High/High10/422/444**) |
| Pixel format | `yuv420p` (8-bit) |
| Resolution | short side ≤ 720, long side ≤ 1280 (i.e. ≤720p, portrait or landscape); scale down preserving aspect, **never upscale** |
| Audio codec | AAC-LC, ≤128 kbps stereo |

### Conformance check (skip transcode when ALL true)

`codec_name == h264` AND `profile ∈ {Constrained Baseline, Baseline, Main}` AND `pix_fmt == yuv420p` AND `max(width, height) ≤ 1280` AND `min(width, height) ≤ 720` AND (no audio OR `audio.codec_name == aac`). Otherwise → transcode.

### What This Does NOT Include

- **Asynchronous/background transcoding + processing-status UI.** v1 transcodes **synchronously** during the upload request (matches the existing synchronous thumbnail step). Async job queue is a v2 if large uploads time out.
- **Image normalization / downscaling** — images pass through unchanged (the `<img>` path is not affected by the profile issue).
- **Adaptive bitrate / multiple renditions** — single kiosk-safe rendition only.
- **HDR tone-mapping, audio loudness normalization.**
- **Automatic backfill of existing media** — covered by a one-off story (Story 5), run on demand, not part of the live upload path.
- **APK upload transcoding** — APKs are not media; unchanged.

---

## Technical Approach

### Technology Stack

- **Probe:** `fluent-ffmpeg` `.ffprobe()` + **`@ffprobe-installer/ffprobe`** (new dep; the project already has `@ffmpeg-installer/ffmpeg` + `fluent-ffmpeg` for thumbnails but no ffprobe binary).
- **Transcode:** `fluent-ffmpeg` + bundled `@ffmpeg-installer/ffmpeg`.
- **Server:** Nitro / Node, Drizzle ORM / better-sqlite3, Vitest.

### Architecture Overview

New service `server/services/transcode.ts`:

```
probeVideo(path) -> { codec, profile, pixFmt, width, height, durationMs, audioCodec }
isKioskSafe(probe) -> boolean
transcodeToKioskSafe(inPath, outPath) -> Promise<void>   // ffmpeg, the profile above
ensureKioskSafe(inPath) -> { path, probe, transcoded: boolean }   // probe; passthrough or transcode to a tmp file
```

`media.post.ts` upload flow (rewritten):

```
1. Stream upload -> tmp/in.bin ; compute SOURCE sha256 while streaming
2. If media row exists with source_sha256 == sourceSha -> return it (dedup, no work)
3. If kind == image -> store as-is (current behavior), derive dims via sharp
   If kind == video:
     a. ensureKioskSafe(tmp/in.bin) -> finalPath (= in.bin if conforming, else tmp/out.mp4)
     b. hash finalPath -> finalSha ; probe finalPath -> width/height/durationMs
     c. if media row exists with sha256 == finalSha -> reuse object, still insert/return row
     d. store.put(finalSha, read(finalPath), 'video/mp4')
4. Thumbnail from finalPath (existing generateVideoThumbnail)
5. Insert media row: sha256 = finalSha, source_sha256 = sourceSha, mime_type='video/mp4',
   width/height/duration from probe
6. Clean up tmp files (finally)
```

### Data Model

`media` table gains one nullable column:

| Column | Type | Purpose |
|---|---|---|
| `source_sha256` | `text` (nullable, indexed) | sha256 of the original upload, for dedup before transcoding. Equals `sha256` when no transcode happened. |

(Drizzle: `text('source_sha256')`; add a non-unique index. Run `pnpm db:generate` + `pnpm db:migrate`.)

### ffmpeg transcode (reference)

```
ffmpeg -i IN \
  -c:v libx264 -profile:v main -pix_fmt yuv420p \
  -vf "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'" \
  -preset veryfast -crf 23 \
  -c:a aac -b:a 128k -ac 2 \
  -movflags +faststart \
  OUT.mp4
```

- The `scale` clamps the **short** side to 720 and lets the long side follow aspect (`-2` keeps it even); `min()` prevents upscaling.
- `+faststart` is belt-and-suspenders (the APK downloads whole files, but non-APK players stream).

### Failure handling

- ffprobe or ffmpeg failure → delete tmp files → `throw createError({ statusCode: 422, message: 'Could not process this video' })`. The dashboard surfaces the error; nothing is stored.
- Transcode is bounded by a timeout (e.g. 10 min) to avoid a stuck request.

---

## Implementation Plan

### Stories

1. **Probe + conformance** — `transcode.ts` `probeVideo` / `isKioskSafe`; add `@ffprobe-installer/ffprobe`; unit-tested against fixture probes.
2. **Transcode** — `transcodeToKioskSafe` + `ensureKioskSafe`; integration test that a High-profile fixture comes out Main/yuv420p/≤720p.
3. **Schema** — `source_sha256` column + index + migration.
4. **Upload pipeline rewrite** — `media.post.ts` uses `ensureKioskSafe`, source-sha dedup, ffprobe-derived dims; API tests.
5. **Backfill (one-off)** — `scripts/transcode-existing.ts` that re-processes existing non-conforming media (re-store under the new sha, update playlist_items + media row). Run manually.

### Development Phases

- **Phase 1:** Stories 1–2 (service + tests, no pipeline wiring) — safe, isolated.
- **Phase 2:** Stories 3–4 (schema + pipeline) — the live change.
- **Phase 3:** Story 5 (backfill) — run once against prod after deploy.

---

## Acceptance Criteria

- Uploading an H.264 **High** clip results in a stored object that ffprobes as **Main / yuv420p**, ≤720p, faststart, `Content-Type: video/mp4` — and **plays on the Xiaomi box**.
- Uploading an already-conforming clip (Main/Baseline, yuv420p, ≤720p) stores it **unchanged** (no re-encode; `transcoded: false`).
- Re-uploading the same source returns the existing row without re-transcoding.
- Non-video (image) uploads are unaffected.
- A corrupt/unsupported video upload returns 422 and stores nothing.
- `media.width/height/duration_ms` reflect the **final** file.
- `pnpm test` green; `pnpm build` succeeds.

## Non-Functional Requirements

### Performance
- Conforming uploads incur only a probe (~tens of ms) — no re-encode.
- `-preset veryfast` keeps transcode time reasonable; a 45 s 720p clip transcodes in a few seconds on the CX box.
- Synchronous transcode blocks the upload request — acceptable for prototype scale; revisit (async job) if large uploads time out behind nginx/Cloudflare (note the 100 MB Cloudflare body cap on the public block — large uploads already must use the tailnet path).

### Security
- ffmpeg runs on untrusted input — rely on the bundled static ffmpeg; no shell string interpolation (use `fluent-ffmpeg` argument API, never a shell command).
- Temp files in `os.tmpdir()`, always cleaned in `finally`.

### Other
- Reuse the existing `@ffmpeg-installer/ffmpeg` + `fluent-ffmpeg` setup from `thumbnails.ts` (same `setFfmpegPath`). Add `setFfprobePath` from `@ffprobe-installer/ffprobe`.
- `onlyBuiltDependencies` / Docker: the bundled ffmpeg/ffprobe binaries must survive the multi-stage build (they're npm packages, already handled for `@ffmpeg-installer`).

## Dependencies
- New: `@ffprobe-installer/ffprobe`.
- Existing: `@ffmpeg-installer/ffmpeg`, `fluent-ffmpeg`, Drizzle, better-sqlite3.

## Risks & Mitigation

| Risk | Mitigation |
|---|---|
| Large uploads time out during synchronous transcode | Document the limit; v2 async job queue; tailnet upload path avoids the Cloudflare 100 MB cap |
| ffprobe binary missing in the Docker image | `@ffprobe-installer/ffprobe` ships the binary as an npm dep (same pattern as the working `@ffmpeg-installer/ffmpeg`); verify in the runtime stage |
| Conformance check too strict/loose (some Main clips still fail, or some High clips slip through) | Profile/pixfmt/resolution rules derived from on-device verification (`webview-h264-high-profile-fails`); err toward transcoding when unsure |
| Backfill changes shas → breaks playlist_items references | Story 5 updates `playlist_items.media_id` (FK by id, not sha) — sha change is internal; bump affected `playlists.version` so devices re-sync |
| Re-encode quality loss | `crf 23` is visually transparent for signage; conforming clips are never re-encoded |

## Timeline
- Phase 1: ~0.5 day · Phase 2: ~1 day · Phase 3: ~0.5 day.

## Approval
- [ ] Reviewed by: dmytro
