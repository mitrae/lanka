# Server-Side Upload Transcoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize every uploaded video to a kiosk-safe encoding (H.264 **Main**, `yuv420p`, ≤720p, `+faststart`, AAC) so any upload plays in the Android WebView. Probe on upload; pass through if already safe, else transcode before storing. Media stays content-addressed by the sha256 of the served (post-transcode) file.

**Why:** The kiosk WebView cannot decode H.264 **High** profile (verified on Xiaomi/Amlogic — memory `webview-h264-high-profile-fails`); most real uploads (phone/Telegram clips) are High and silently show a placeholder. This eliminates that class of failure fleet-wide.

**Spec:** `docs/superpowers/specs/2026-06-28-server-side-upload-transcoding-design.md`

**Tech Stack:** Nitro/Node · `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` (existing) + `@ffprobe-installer/ffprobe` (new) · Drizzle ORM / better-sqlite3 · Vitest.

## Global Constraints

- Nuxt 4, SPA mode; package manager **pnpm**; tests via `pnpm test` (Vitest, `pool: 'forks'`).
- DB: better-sqlite3 via Drizzle; all DB ops use `await`. New schema → `pnpm db:generate` then `pnpm db:migrate`.
- `~` alias resolves to project root in Nuxt and Vitest.
- Media store is pluggable (`MediaStore`): `LocalDiskStore` (dev/test) or `R2Store` (prod). `store.put(sha, stream, contentType?)` — pass `'video/mp4'`.
- ffmpeg is the **bundled** static binary (`@ffmpeg-installer/ffmpeg`), wired in `server/services/thumbnails.ts` via `ffmpeg.setFfmpegPath(...)`. **Never** build shell command strings — use the `fluent-ffmpeg` argument API.
- Temp files in `os.tmpdir()`, always removed in `finally`.
- Tests stub Nitro auto-imports via `tests/helpers/nuxt-stubs.ts` — call `handleXxx` functions directly.

## File Map

### New files
| Path | Purpose |
|---|---|
| `server/services/transcode.ts` | `probeVideo`, `isKioskSafe`, `transcodeToKioskSafe`, `ensureKioskSafe` |
| `tests/services/transcode.test.ts` | Unit tests for probe/conformance (+ optional slow transcode integration test) |
| `scripts/transcode-existing.ts` | One-off backfill of existing non-conforming media |

### Modified files
| Path | Change |
|---|---|
| `package.json` | + `@ffprobe-installer/ffprobe` |
| `server/db/schema.ts` | + `source_sha256` column + index on `media` |
| `server/api/media.post.ts` | Rewrite upload flow: probe → ensure-safe → final-sha → dedup → store → thumbnail → insert |
| `tests/api/*media*.test.ts` | Cover transcode/passthrough/dedup/422 paths (add mock or fixtures) |
| `drizzle/*` | Generated migration |

---

## Task 1: Transcode service + ffprobe dependency

- [ ] `pnpm add @ffprobe-installer/ffprobe` and add to `onlyBuiltDependencies` alongside `@ffmpeg-installer/ffmpeg` if needed.
- [ ] Create `server/services/transcode.ts`:
  - Set paths once: `ffmpeg.setFfmpegPath(ffmpegInstaller.path)`, `ffmpeg.setFfprobePath(ffprobeInstaller.path)`.
  - `export interface VideoProbe { codec: string; profile: string; pixFmt: string; width: number; height: number; durationMs: number; audioCodec: string | null }`
  - `export async function probeVideo(path: string): Promise<VideoProbe>` — wrap `ffmpeg.ffprobe`; pull the first video stream + first audio stream; map `profile` (note ffprobe gives e.g. `"High"`, `"Main"`, `"Constrained Baseline"`), `pix_fmt`, `width`, `height`, `duration` (×1000 → ms), audio `codec_name`.
  - `export function isKioskSafe(p: VideoProbe): boolean` — per spec: `codec==='h264'` && `['Constrained Baseline','Baseline','Main'].includes(profile)` && `pixFmt==='yuv420p'` && `Math.max(width,height)<=1280` && `Math.min(width,height)<=720` && (`audioCodec===null || audioCodec==='aac'`).
  - `export async function transcodeToKioskSafe(inPath: string, outPath: string): Promise<void>` — `fluent-ffmpeg(inPath)` with outputOptions: `-c:v libx264`, `-profile:v main`, `-pix_fmt yuv420p`, the `scale` filter from the spec (short side ≤720, no upscale, even dims), `-preset veryfast`, `-crf 23`, `-c:a aac`, `-b:a 128k`, `-ac 2`, `-movflags +faststart`. Bound with a timeout; reject on `error`.
  - `export async function ensureKioskSafe(inPath: string, tmpDir: string): Promise<{ path: string; probe: VideoProbe; transcoded: boolean }>` — `probeVideo`; if `isKioskSafe` → `{ path: inPath, probe, transcoded:false }`; else transcode to `${tmpDir}/out.mp4`, re-probe the output, return `{ path: out, probe: outProbe, transcoded:true }`.
- [ ] `tests/services/transcode.test.ts`:
  - `isKioskSafe` truth table (High→false, Main→true, Baseline→true, yuv422p→false, 1080p→false, hevc→false, no-audio→true, mp3-audio→false).
  - (Optional, may be slow/marked) integration: transcode a tiny generated High-profile fixture (`ffmpeg -f lavfi -i testsrc -profile:v high …`) and assert the output probes Main/yuv420p/≤720p.
- [ ] `pnpm test` green for the new file.

## Task 2: Schema — `source_sha256`

- [ ] In `server/db/schema.ts` `media` table add `sourceSha256: text('source_sha256')` and a non-unique index `media_source_sha_idx` on it.
- [ ] `pnpm db:generate` → review the generated migration (additive column; no table rebuild).
- [ ] `pnpm db:migrate` against `data/signage.db`.
- [ ] Confirm existing `media` tests still pass.

## Task 3: Upload pipeline rewrite (`media.post.ts`)

- [ ] Restructure `handleUploadMedia` (the inner handler) to the spec flow:
  - Stream upload to `tmpDir/in.bin`, computing the **source** sha256 + byte count while streaming (as today).
  - Reject empty uploads (existing check).
  - **Dedup by source:** `select … from media where source_sha256 = sourceSha` → if found, return it (no transcode, no store).
  - **Images:** keep current behavior (store as-is; dims via the existing path). Set `sourceSha256 = sha256` (= the stored sha).
  - **Videos:** `const { path: finalPath, probe, transcoded } = await ensureKioskSafe(tmpIn, tmpDir)`; hash `finalPath` → `finalSha`; if a row already has `sha256 = finalSha`, reuse the stored object (skip `store.put`) but still insert/return a row (or return the existing); else `await store.put(finalSha, createReadStream(finalPath), 'video/mp4')`.
  - **Thumbnail:** generate from `finalPath` (videos) as today.
  - **Insert row:** `sha256 = finalSha`, `sourceSha256 = sourceSha`, `mimeType = 'video/mp4'` (videos), `width/height/durationMs` from `probe` (authoritative — replaces client-provided values), `kind`, `filename`, `bytes` = size of the **final** file.
  - `finally` { remove `tmpDir` }.
  - On ffprobe/ffmpeg throw → `createError({ statusCode: 422, message: 'Could not process this video' })`.
- [ ] Keep the multipart parsing (`fields.kind`, `filename`, etc.) — but `mimeType`/`width`/`height`/`durationMs` for videos now come from the probe, not the client.
- [ ] Tests (`tests/api/...`): mock `ensureKioskSafe` (so API tests stay fast/deterministic) to assert: (a) non-conforming → `store.put` called with the transcoded sha + `'video/mp4'`; (b) conforming → passthrough (`transcoded:false`); (c) source-dedup returns existing row without calling `ensureKioskSafe`/`put`; (d) transcode throw → 422; (e) image path unchanged.
- [ ] `pnpm test` + `pnpm build` green.

## Task 4: Backfill existing media (one-off)

- [ ] `scripts/transcode-existing.ts`: for each `media` row where `kind='video'`, fetch bytes via the configured `MediaStore.open(sha)`, `probeVideo`, and if not `isKioskSafe`: transcode → new sha → `store.put(newSha,…, 'video/mp4')` → update the `media` row (`sha256=newSha`, `sourceSha256=oldSha`, new dims/mime/bytes) → bump `playlists.version` for any playlist containing it (so devices re-sync) → optionally `store.delete(oldSha)`.
  - `playlist_items.media_id` is an FK by **id**, so the sha change is internal — no item rewiring needed, just the version bump.
  - Idempotent: skip rows already conforming.
- [ ] Document run: `node` against the prod env (or via a one-off container exec) — **not** part of the request path. Run after deploying Tasks 1–3.

## Task 5: Deploy + verify

- [ ] Merge to `main`, push, `ssh lanka-prod 'cd /opt/lanka && ./scripts/deploy.sh'` (rebuild bakes the new ffprobe dep into the image).
- [ ] Verify ffprobe binary present in the runtime image (`docker exec lanka node -e "console.log(require('@ffprobe-installer/ffprobe').path)"` + the file exists).
- [ ] Upload a known **High-profile** clip via the dashboard → confirm the stored object ffprobes as **Main/yuv420p/≤720p** and **plays on the Xiaomi box**.
- [ ] Run the Task 4 backfill once for existing High-profile media (e.g. `IMG_5609.MP4`, `video_2024-…mp4`).

---

## Post-implementation checklist
- [ ] `pnpm test` (Vitest) all green; `pnpm build` succeeds.
- [ ] New ffprobe dep survives the Docker multi-stage build (present in runtime stage).
- [ ] High-profile upload → playable on-device; conforming upload → not re-encoded; same-source re-upload → deduped; bad video → 422.
- [ ] Backfill run; affected playlists bumped; devices re-synced and playing.
- [ ] Update `CLAUDE.md` (media gotchas) + memory `webview-h264-high-profile-fails` to note transcoding is now automatic on upload.
