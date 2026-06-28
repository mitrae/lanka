# Upload Quality Presets

**Date:** 2026-06-28
**Status:** Design approved, pending implementation plan
**Related:** `2026-06-28-server-side-upload-transcoding-design.md` (the transcode pipeline this extends), `2026-06-28-lanka-native-exoplayer-flavor-design.md` (native player that can decode 1080p)

## Summary

Let an operator choose a **quality preset** (Low / Standard / High) when uploading media. The server transcodes the upload to that preset's target (resolution cap + CRF + audio bitrate), instead of the single hardcoded kiosk-safe profile it uses today. Standard reproduces today's exact behavior and is the default, so existing callers and already-uploaded media are unaffected.

## Motivation

Every upload is currently transcoded to a fixed profile — H.264 Main, yuv420p, ≤720p, CRF 23. A high-bitrate 1080p master (e.g. ~25 Mbps, 91 MB / 30 s) is downscaled to 720p and lands at ~8 MB. That is correct and intentional (fleet-wide WebView safety + size), but the operator has no say: they can't keep 1080p for a hero asset on capable boxes, nor trade more compression for a smaller file on a low-priority clip. The new **native ExoPlayer player decodes 1080p Main natively**, so "keep 1080p" is now a real option for native-targeted content. This feature gives the operator that control at upload time.

## Decisions (locked during brainstorming)

- **Simple named presets** (Low / Standard / High), not raw CRF/resolution knobs.
- **High = 1080p**, and it is the operator's responsibility to only assign High-resolution media to native-capable boxes. No surface-aware assignment warnings (out of scope).
- **Per-upload choice** (not a global setting, not a re-changeable property).
- **Always encode to the chosen preset** (scale-down only), replacing the current *skip-if-already-kiosk-safe* fast path, so output size is predictable at every preset.

## Preset definitions

All presets produce H.264 **Main** profile, `yuv420p`, `+faststart`, AAC audio, scaling **down only** (never upscale), with even dimensions. They differ only in the resolution cap, CRF, and audio bitrate:

| Preset | Max long side | Max short side | CRF | Audio | Plays on |
|---|---|---|---|---|---|
| `low` | 854 | 480 | 26 | 96k | all devices |
| `standard` (default) | 1280 | 720 | 23 | 128k | all devices |
| `high` | 1920 | 1080 | 20 | 128k | native ExoPlayer boxes (operator's call for WebView) |

`standard` is byte-for-byte the current pipeline behavior (same caps, CRF, audio).

Presets are a hardcoded table in `server/services/transcode.ts` — not user-configurable (YAGNI).

## Architecture

The change is confined to the transcode service, the upload endpoint, the media schema, and two dashboard components. The control plane, player, and device sync are untouched (a media item is still a single content-addressed file; players never see "quality").

### 1. Transcode service (`server/services/transcode.ts`)

- Add `export type QualityPreset = 'low' | 'standard' | 'high'` and a `QUALITY_PRESETS: Record<QualityPreset, { maxLong: number; maxShort: number; crf: number; audioBitrate: string }>` table with the values above.
- `transcodeToKioskSafe(inPath, outPath)` → `transcodeToKioskSafe(inPath, outPath, preset: QualityPreset)`. The existing two-pass scale filter is generalized to use `preset.maxShort`/`preset.maxLong` instead of the hardcoded `720`/`1280`; `-crf` and `-b:a` come from the preset. Profile stays `main`, pix_fmt `yuv420p`, preset `veryfast`, `+faststart` — unchanged.
- `ensureKioskSafe(inPath, tmpDir)` → **`ensureQuality(inPath, tmpDir, preset: QualityPreset)`** (the existing 2-arg signature gains the preset). It now **always transcodes to the preset** (returns `{ path: outPath, probe, transcoded: true }`), dropping the `isKioskSafe` skip on the upload path. `probeVideo` is still used for the source dimensions/duration metadata. `isKioskSafe` **remains exported** (still used by the backfill script's own skip logic and the transcode tests) but is no longer on the upload hot path.
  - Rationale for always-encode: with the skip path, a `high` upload of an already-1080p-Main source would be returned untouched (keeping the full 25 Mbps / 91 MB), defeating the point of a controlled-size High. Always-encoding guarantees the output matches the preset's CRF target. Re-encoding an already-optimized file is a rare, low-cost case; identical re-uploads are caught by dedup (below).

**Callers of the renamed `ensureKioskSafe` to update** (the rename is the only breaking change; each gets a preset arg):
  - `server/api/media.post.ts` — passes the request's `quality` (below).
  - `scripts/transcode-existing.ts` — passes `'standard'` to preserve its current backfill behavior; keeps its own `isKioskSafe(probe)` pre-check.
  - `tests/integration/sync-flow.test.ts` — the `vi.mocked(ensureKioskSafe)` mock is renamed; its implementation already ignores the extra arg.
  - `tests/services/transcode.test.ts` — updates the `ensureKioskSafe` import/calls to `ensureQuality(..., 'standard')`; `isKioskSafe` truth-table tests are unchanged.

### 2. Upload endpoint (`server/api/media.post.ts`)

- Read an optional `quality` multipart field alongside the existing `kind`/`durationMs` (formidable `fields.quality`). Validate against the three presets; default to `'standard'` when absent or invalid-but-empty. (An explicitly invalid non-empty value → 400, mirroring the `kind` validation.)
- Pass `quality` into `ingestMedia` → `ensureQuality(tmpPath, quality)`.
- **Dedup key becomes `(sourceSha256, quality)`**: the early "source already ingested" lookup matches on both columns, so the same source uploaded at two qualities yields two media rows, and re-uploading the same source at the same quality still returns the existing row. Persist `quality` on the inserted `media` row.

### 3. Schema (`server/db/schema.ts` + migration)

- Add `quality: text('quality').notNull().default('standard')` to the `media` table.
- The existing `source_sha256` index (`media_source_sha_idx`) becomes a composite index on `(source_sha256, quality)` to support the new dedup lookup. (Additive migration: add the `quality` column; drop+recreate the index as composite. Existing rows default to `'standard'`.)

### 4. Dashboard

- **`app/components/MediaUploadDialog.vue`** — add a 3-option preset selector (e.g. `URadioGroup`/`USelect`, matching existing form controls), default **Standard**, with a one-line hint per option ("Low — 480p, smallest", "Standard — 720p, plays everywhere", "High — 1080p, larger, native boxes"). Include `quality` in the upload `FormData`.
- **`app/components/MediaDetailDrawer.vue`** (+ the `Media`/`MediaDetail` types in `app/types/api.ts` and `useApiClient`) — surface the stored `quality` as a small badge on the media detail, so an operator can see what a given item was encoded as.

## Data flow

```
Upload dialog (preset selector, default Standard)
  └─ FormData { file, kind, durationMs?, quality }
       └─ POST /api/media
            ├─ dedup lookup on (sourceSha256, quality) → hit? return existing
            └─ ensureQuality(tmp, quality) ──> transcodeToKioskSafe(tmp, out, PRESET[quality])
                 └─ store output by sha, insert media row { …, quality }
```

Players are unaffected: the manifest still references a media item by `sha256`; the transcoded bytes are whatever the chosen preset produced.

## Error handling

- Invalid non-empty `quality` → 400 (consistent with `kind`).
- Transcode failure for a preset → the existing `media.post.ts` error path (500) is unchanged; presets only change the ffmpeg arguments, not the failure modes. The known transcode edge cases (probe NaN duration, ffmpeg timeout, ultra-wide two-pass scale) are preset-agnostic and already covered.
- Default-on-absent (`'standard'`) means any existing or non-dashboard caller that omits `quality` behaves exactly as before.

## Testing

- **Unit (`server/services/transcode.ts`):** `QUALITY_PRESETS` has the three expected entries; `transcodeToKioskSafe` with each preset produces output at the expected resolution cap (probe the output like the existing transcode tests — a 1080p source → `low` ≤480 short / `high` ≤1080) and the CRF/audio args are wired from the preset. The existing transcode tests keep passing by defaulting to `'standard'`.
- **API (`tests/api/...media...`):** `quality` persists on the media row; dedup returns the existing row for same `(source, quality)` and a new row for the same source at a different quality; omitting `quality` stores `'standard'`; an invalid value 400s.
- **Dashboard:** the upload dialog includes `quality` in the request (component-level assertion if the project tests components; otherwise verify via `pnpm build` + the API test). No strong UI test required for the badge.

## Out of scope (YAGNI)

- Re-transcoding existing media to a different quality (no re-encode UI/job).
- Per-device / per-surface renditions of a single media item (adaptive/multi-rendition).
- Configurable or custom presets.
- Surface-aware assignment warnings (blocking 1080p media on WebView devices).
- Applying quality to images (presets are video-only; images ingest unchanged).
