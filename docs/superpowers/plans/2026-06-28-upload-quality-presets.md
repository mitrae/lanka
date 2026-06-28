# Upload Quality Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator choose a Low/Standard/High quality preset at upload time; the server transcodes the video to that preset's resolution cap + CRF + audio bitrate instead of the single hardcoded kiosk-safe profile.

**Architecture:** Parameterize the existing transcode service with a preset table; thread a `quality` field from the upload form through `media.post.ts` into the transcode call; persist it on the `media` row and dedup on `(source_sha256, quality)`. Standard reproduces today's exact behavior and is the default, so nothing already uploaded or any other caller changes.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle ORM (better-sqlite3), Vitest, formidable, fluent-ffmpeg (`@ffmpeg-installer`/`@ffprobe-installer`), Nuxt UI v3, vue-i18n.

## Global Constraints

- **Presets** (H.264 **Main**, `yuv420p`, `veryfast`, `+faststart`, scale-DOWN only, AAC):
  - `low` — maxLong 854, maxShort 480, CRF 26, audio 96k
  - `standard` — maxLong 1280, maxShort 720, CRF 23, audio 128k  ← **default; byte-for-byte today's behavior**
  - `high` — maxLong 1920, maxShort 1080, CRF 20, audio 128k
- **`standard` is the default** everywhere `quality` is absent (API field omitted, existing rows, other callers).
- **Always-encode to the preset** on the upload path (drop the `isKioskSafe` skip). `isKioskSafe` stays exported (backfill script + transcode tests use it).
- **Dedup key = `(source_sha256, quality)`**.
- **Presets are a hardcoded table** in `server/services/transcode.ts` — not user-configurable.
- **Quality is video-only** — the image ingest path is unchanged.
- Run the server test suite with `pnpm test`; focused file with `pnpm test -- <path>`. `~` alias = repo root. Vitest `pool: 'forks'`.
- Branch: `upload-quality-presets` (already created). An unrelated user edit to `CLAUDE.md` is uncommitted in the working tree — never stage it.

---

## File Structure

- `server/db/schema.ts` — add `media.quality` column + make `media_source_sha_idx` composite (Task 1).
- `server/db/migrations/<nnnn>_*.sql` — generated (Task 1).
- `server/services/transcode.ts` — `QUALITY_PRESETS` table; parameterized `transcodeToKioskSafe`; `ensureKioskSafe`→`ensureQuality` (always-encode) (Task 2).
- `scripts/transcode-existing.ts`, `tests/services/transcode.test.ts`, `tests/integration/sync-flow.test.ts` — updated for the rename (Task 2).
- `server/api/media.post.ts` — read `quality` field, thread to `ensureQuality`, dedup on `(source, quality)`, persist (Task 3).
- `app/components/MediaUploadDialog.vue`, `app/components/MediaDetailDrawer.vue`, `app/types/api.ts`, locale files — preset selector + quality badge (Task 4).

---

## Task 1: Schema — `media.quality` column + composite source index

**Files:**
- Modify: `server/db/schema.ts` (media table ~lines 80-84)
- Generate: `server/db/migrations/<nnnn>_*.sql`
- Test: `tests/api/media.test.ts` (or the existing media API test file — see Step 3)

**Interfaces:**
- Produces: `media.quality` column (`text` NOT NULL DEFAULT `'standard'`); index `media_source_sha_idx` on `(source_sha256, quality)`.

- [ ] **Step 1: Add the column + composite index to the schema**

In `server/db/schema.ts`, in the `media` table: add the `quality` column next to `sourceSha256`, and change the source index to composite. The columns block currently ends with `sourceSha256: text('source_sha256'),` and the index block has `sourceShaIdx: index('media_source_sha_idx').on(t.sourceSha256)`. Make them:

```ts
    sourceSha256: text('source_sha256'),
    quality: text('quality').notNull().default('standard'),
```

and

```ts
    sourceShaIdx: index('media_source_sha_idx').on(t.sourceSha256, t.quality)
```

- [ ] **Step 2: Generate + apply the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/<nnnn>_*.sql` containing roughly:
```sql
ALTER TABLE `media` ADD `quality` text DEFAULT 'standard' NOT NULL;
DROP INDEX `media_source_sha_idx`;
CREATE INDEX `media_source_sha_idx` ON `media` (`source_sha256`,`quality`);
```
Then `pnpm db:migrate`. If `db:generate` shows an interactive prompt or an unrelated diff, STOP and report.

- [ ] **Step 3: Write a failing test for the default**

In the existing media API test file (`tests/api/media.test.ts` if present; otherwise add to `tests/api/media-upload.test.ts` — pick the file that already exercises `ingestMedia`/image upload), add a test that an ingested image row defaults `quality` to `'standard'`. Use the file's existing test-db + `ingestMedia` (or `handleUploadMedia`) setup; mirror how other tests in that file build an image `IngestInput`. Assertion:

```ts
expect(row.quality).toBe('standard')
```

If no media test file imports `ingestMedia` yet, add a minimal one:
```ts
import { ingestMedia } from '~/server/api/media.post'
// ...build a tiny PNG IngestInput like the existing image tests, then:
const row = await ingestMedia(db, store, imageInput)
expect(row.quality).toBe('standard')
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- tests/api/media.test.ts`
Expected: FAIL — `row.quality` is `undefined` (column/select not present) before the migration is applied to the test DB, OR the test-db helper rebuilds schema from `schema.ts` and it passes immediately. If it passes immediately because the test DB is built from `schema.ts`, that's acceptable — note it and continue (the column exists). The point is the column is present and defaults correctly.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS (the additive column + composite index don't change existing behavior).

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/migrations tests/api/media.test.ts
git commit -m "feat(media): add quality column + composite (source,quality) index"
```

---

## Task 2: Transcode service — preset table + always-encode `ensureQuality`

**Files:**
- Modify: `server/services/transcode.ts`
- Modify: `scripts/transcode-existing.ts` (caller rename, pass `'standard'`)
- Modify: `server/api/media.post.ts:16,82,84` (import + call rename, pass `'standard'` for now)
- Modify: `tests/integration/sync-flow.test.ts` (mock rename)
- Test: `tests/services/transcode.test.ts`

**Interfaces:**
- Produces:
  - `export type QualityPreset = 'low' | 'standard' | 'high'`
  - `export const QUALITY_PRESETS: Record<QualityPreset, { maxLong: number; maxShort: number; crf: number; audioBitrate: string }>`
  - `transcodeToKioskSafe(inPath: string, outPath: string, preset: QualityPreset): Promise<void>`
  - `ensureQuality(inPath: string, tmpDir: string, preset: QualityPreset): Promise<{ path: string; probe: VideoProbe; transcoded: boolean }>` — **always** transcodes (`transcoded: true`).
  - `isKioskSafe(p: VideoProbe): boolean` — unchanged, still exported.

- [ ] **Step 1: Write failing tests for the preset table + parameterized transcode**

In `tests/services/transcode.test.ts`, add (the file already has `generateClip(outPath, {profile,width,height,durationSecs})`, `makeTmpDir()`, and imports ffmpeg + probeVideo helpers — reuse them; add `QUALITY_PRESETS`, `transcodeToKioskSafe`, `ensureQuality` to the import line):

```ts
import { QUALITY_PRESETS, transcodeToKioskSafe, ensureQuality } from '../../server/services/transcode'
import { probeVideo } from '../../server/services/transcode'

describe('QUALITY_PRESETS', () => {
  it('has low/standard/high with the agreed caps + crf', () => {
    expect(QUALITY_PRESETS.low).toEqual({ maxLong: 854, maxShort: 480, crf: 26, audioBitrate: '96k' })
    expect(QUALITY_PRESETS.standard).toEqual({ maxLong: 1280, maxShort: 720, crf: 23, audioBitrate: '128k' })
    expect(QUALITY_PRESETS.high).toEqual({ maxLong: 1920, maxShort: 1080, crf: 20, audioBitrate: '128k' })
  })
})

describe('transcodeToKioskSafe per preset', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it.each([
    ['low', 854, 480],
    ['standard', 1280, 720],
    ['high', 1920, 1080],
  ] as const)('caps a 1080p source to %s (<=%i long / <=%i short), Main/yuv420p', async (preset, long, short) => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    const out = join(dir, 'out.mp4')
    await generateClip(src, { profile: 'high', width: 1920, height: 1080, durationSecs: 1 })
    await transcodeToKioskSafe(src, out, preset)
    const p = await probeVideo(out)
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(long)
    expect(Math.min(p.width, p.height)).toBeLessThanOrEqual(short)
    expect(p.profile).toBe('Main')
    expect(p.pixFmt).toBe('yuv420p')
  }, 60_000)
})

describe('ensureQuality always re-encodes', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('transcodes even an already-safe source (transcoded:true) and applies the preset', async () => {
    dir = makeTmpDir()
    const src = join(dir, 'src.mp4')
    // already kiosk-safe: Main, 640x360
    await generateClip(src, { profile: 'main', width: 640, height: 360, durationSecs: 1 })
    const res = await ensureQuality(src, dir, 'standard')
    expect(res.transcoded).toBe(true)
    expect(res.path).not.toBe(src)
    expect(res.probe.profile).toBe('Main')
  }, 60_000)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/services/transcode.test.ts`
Expected: FAIL — `QUALITY_PRESETS` / `transcodeToKioskSafe`(3-arg) / `ensureQuality` not exported.

- [ ] **Step 3: Implement the preset table + parameterized functions**

In `server/services/transcode.ts`:

Add after the `VideoProbe` interface (and keep `isKioskSafe` exactly as-is):

```ts
export type QualityPreset = 'low' | 'standard' | 'high'

/** Resolution cap (scale-down only), CRF, and audio bitrate per preset.
 *  All presets emit H.264 Main / yuv420p / +faststart. `standard` reproduces
 *  the original hardcoded kiosk-safe profile. */
export const QUALITY_PRESETS: Record<QualityPreset, {
  maxLong: number
  maxShort: number
  crf: number
  audioBitrate: string
}> = {
  low: { maxLong: 854, maxShort: 480, crf: 26, audioBitrate: '96k' },
  standard: { maxLong: 1280, maxShort: 720, crf: 23, audioBitrate: '128k' },
  high: { maxLong: 1920, maxShort: 1080, crf: 20, audioBitrate: '128k' },
}
```

Replace `transcodeToKioskSafe(inPath, outPath)` with the preset-parameterized version — the two-pass scale filter uses `p.maxShort`/`p.maxLong`, and `-crf`/`-b:a` come from the preset:

```ts
export async function transcodeToKioskSafe(
  inPath: string,
  outPath: string,
  preset: QualityPreset
): Promise<void> {
  const p = QUALITY_PRESETS[preset]
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inPath)
      .outputOptions([
        '-vf',
        `scale='if(gt(iw,ih),-2,min(${p.maxShort},iw))':'if(gt(iw,ih),min(${p.maxShort},ih),-2)',scale='if(gt(iw,ih),min(${p.maxLong},iw),-2)':'if(gt(iw,ih),-2,min(${p.maxLong},ih))'`,
        '-c:v', 'libx264',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', String(p.crf),
        '-c:a', 'aac',
        '-b:a', p.audioBitrate,
        '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)

    const timer = setTimeout(() => {
      command.kill('SIGKILL')
      reject(new Error(`Transcode timeout after ${TRANSCODE_TIMEOUT_MS}ms`))
    }, TRANSCODE_TIMEOUT_MS)

    command.on('end', () => { clearTimeout(timer); resolve() })
    command.on('error', (err) => { clearTimeout(timer); reject(err) })
    command.run()
  })
}
```

Replace `ensureKioskSafe` with `ensureQuality` (always transcodes; no `isKioskSafe` skip):

```ts
/**
 * Transcodes a video to the chosen quality preset (always re-encodes), writing
 * to `${tmpDir}/out.mp4`. Returns the output path + a fresh probe.
 */
export async function ensureQuality(
  inPath: string,
  tmpDir: string,
  preset: QualityPreset
): Promise<{ path: string; probe: VideoProbe; transcoded: boolean }> {
  const outPath = join(tmpDir, 'out.mp4')
  await transcodeToKioskSafe(inPath, outPath, preset)
  const outProbe = await probeVideo(outPath)
  return { path: outPath, probe: outProbe, transcoded: true }
}
```

- [ ] **Step 4: Update the non-endpoint callers so the build stays green**

`scripts/transcode-existing.ts` (line ~43 import, line ~152 call): change the import `ensureKioskSafe` → `ensureQuality`; keep `isKioskSafe`. The call `await ensureKioskSafe(tmpIn, tmpDir)` → `await ensureQuality(tmpIn, tmpDir, 'standard')`. (Its own `if (isKioskSafe(probe)) { ...skip... }` pre-check stays — the backfill still skips already-safe media.)

`tests/integration/sync-flow.test.ts` (lines ~13, ~20): rename the import and `vi.mocked(ensureKioskSafe)` → `ensureQuality`. The mock implementation `async (inPath) => ({...})` already ignores extra args — leave its body, it satisfies the new 3-arg signature.

`server/api/media.post.ts` (line 16 import, line 82 type, line 84 call): import `ensureQuality` instead of `ensureKioskSafe`; `let result: Awaited<ReturnType<typeof ensureQuality>>`; `result = await ensureQuality(tmpPath, tmpDir, 'standard')`. (The real `quality` field is wired in Task 3.)

In `tests/services/transcode.test.ts`, the existing `ensureKioskSafe` tests (the ones asserting `transcoded: false` for already-safe input and `transcoded: true` for unsafe) must be updated: replace `ensureKioskSafe(x, dir)` with `ensureQuality(x, dir, 'standard')`, and change any `expect(res.transcoded).toBe(false)` to `toBe(true)` (always-encode). The `isKioskSafe` truth-table tests are unchanged.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test -- tests/services/transcode.test.ts` then `pnpm test`
Expected: PASS (new preset tests green; existing transcode + sync-flow tests green after the rename).

- [ ] **Step 6: Commit**

```bash
git add server/services/transcode.ts scripts/transcode-existing.ts server/api/media.post.ts tests/services/transcode.test.ts tests/integration/sync-flow.test.ts
git commit -m "feat(transcode): quality presets + always-encode ensureQuality"
```

---

## Task 3: Upload endpoint — `quality` field, dedup, persist

**Files:**
- Modify: `server/api/media.post.ts` (`IngestInput`, `ingestMedia` dedup + insert, handler field read)
- Test: `tests/api/media.test.ts` (or the media upload test file used in Task 1)

**Interfaces:**
- Consumes: `ensureQuality(inPath, tmpDir, preset)`, `QualityPreset`, `QUALITY_PRESETS` from Task 2; `media.quality` column from Task 1.
- Produces: `IngestInput.quality?: QualityPreset`; `POST /api/media` accepts a `quality` form field; media row persists `quality`; dedup on `(sourceSha256, quality)`.

- [ ] **Step 1: Write the failing API tests**

In the media API test file, add (mirror the file's existing upload/ingest setup — a real test DB + a MediaStore double + an `IngestInput`; for video tests follow how the transcode is mocked there, OR use a tiny real clip if the file already does real transcodes):

```ts
it('persists the chosen quality on the media row', async () => {
  const row = await ingestMedia(db, store, { ...videoInput(), quality: 'high' })
  expect(row.quality).toBe('high')
})

it('defaults quality to standard when omitted', async () => {
  const row = await ingestMedia(db, store, videoInput())
  expect(row.quality).toBe('standard')
})

it('dedups on (source, quality): same source+quality returns the same row', async () => {
  const a = await ingestMedia(db, store, { ...videoInput(), quality: 'standard' })
  const b = await ingestMedia(db, store, { ...videoInput(), quality: 'standard' })
  expect(b.id).toBe(a.id)
})

it('same source at a different quality creates a new row', async () => {
  const a = await ingestMedia(db, store, { ...videoInput(), quality: 'standard' })
  const c = await ingestMedia(db, store, { ...videoInput(), quality: 'high' })
  expect(c.id).not.toBe(a.id)
})
```

`videoInput()` builds an `IngestInput` whose `stream` is a small real clip (use the transcode test's `generateClip` to make one in a `beforeAll`, then `createReadStream` it per call) — the source bytes must be identical across calls so `sourceSha256` matches. If the existing file mocks `ensureQuality`, mock it to return a fixed output so the dedup logic (not ffmpeg) is under test; keep the `sourceSha256` derived from the real input bytes.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/api/media.test.ts`
Expected: FAIL — `quality` not on `IngestInput`/not persisted; dedup ignores quality.

- [ ] **Step 3: Implement the endpoint changes**

In `server/api/media.post.ts`:

(a) Add `quality` to `IngestInput` and import the type:
```ts
import { ensureQuality, type QualityPreset } from '~/server/services/transcode'
```
```ts
export type IngestInput = {
  stream: Readable
  filename: string
  kind: 'video' | 'image'
  mimeType?: string
  durationMs?: number
  width?: number
  height?: number
  quality?: QualityPreset
}
```

(b) Resolve the preset once at the top of `ingestMedia` (after computing `sourceSha`), defaulting to `'standard'`:
```ts
const quality: QualityPreset = input.quality ?? 'standard'
```

(c) Change the source-dedup lookup (step 1 in `ingestMedia`) to match on both columns:
```ts
import { and, eq } from 'drizzle-orm' // ensure `and` is imported
// ...
const sourceExisting = await db
  .select()
  .from(schema.media)
  .where(and(eq(schema.media.sourceSha256, sourceSha), eq(schema.media.quality, quality)))
  .get()
if (sourceExisting) return sourceExisting
```

(d) In the video branch, pass the preset: `result = await ensureQuality(tmpPath, tmpDir, quality)`.

(e) Add `quality` to the insert `.values({...})`:
```ts
        width: finalWidth,
        height: finalHeight,
        quality
```

(f) In the `defineEventHandler`, read the form field (after the `kind` validation), mirroring `kind`:
```ts
const qualityRaw = Array.isArray(fields.quality) ? fields.quality[0] : fields.quality
const QUALITIES = ['low', 'standard', 'high'] as const
const quality: QualityPreset = QUALITIES.includes(qualityRaw as any)
  ? (qualityRaw as QualityPreset)
  : 'standard'
```
and pass `quality` into the `ingestMedia({ ... })` call.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- tests/api/media.test.ts` then `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/media.post.ts tests/api/media.test.ts
git commit -m "feat(media): accept quality on upload; dedup + persist per (source,quality)"
```

---

## Task 4: Dashboard — preset selector + quality badge

**Files:**
- Modify: `app/components/MediaUploadDialog.vue`
- Modify: `app/components/MediaDetailDrawer.vue`
- Modify: `app/types/api.ts` (`Media`/`MediaDetail` type)
- Modify: locale files (the `en` + `uk` JSON/TS under the project's i18n dir — find via `components.mediaUploadDialog`)

**Interfaces:**
- Consumes: `POST /api/media` `quality` field (Task 3); `media.quality` returned on the row.
- Produces: upload dialog sends `quality`; media detail shows a quality badge.

- [ ] **Step 1: Add `quality` to the client Media type**

In `app/types/api.ts`, add `quality: 'low' | 'standard' | 'high'` to the `Media` (and `MediaDetail` if separate) type so the badge and any consumer are typed. (The API already returns the full row; this just types it.)

- [ ] **Step 2: Add the preset selector to the upload dialog**

In `app/components/MediaUploadDialog.vue`:
- Add a ref: `const quality = ref<'low' | 'standard' | 'high'>('standard')`.
- In `upload()`, after `form.append('kind', kindOf(f))`, add: `form.append('quality', quality.value)`.
- Add a selector to the template above the action buttons (only meaningful for video; label it as video quality). Use the project's existing select control (`USelect`/`URadioGroup` as used elsewhere). Example with `USelect`:
```vue
<div class="mt-4">
  <label class="text-sm font-medium">{{ $t('components.mediaUploadDialog.quality.label') }}</label>
  <USelect
    v-model="quality"
    :items="[
      { label: $t('components.mediaUploadDialog.quality.low'), value: 'low' },
      { label: $t('components.mediaUploadDialog.quality.standard'), value: 'standard' },
      { label: $t('components.mediaUploadDialog.quality.high'), value: 'high' },
    ]"
    class="mt-1 w-full"
  />
  <p class="mt-1 text-xs text-(--ui-text-muted)">{{ $t('components.mediaUploadDialog.quality.hint') }}</p>
</div>
```
(Match the actual `USelect` API version in this project — check another component that uses `USelect` for the correct `:items`/`:options` prop name.)

- [ ] **Step 3: Add i18n keys**

In the locale files (find the file containing `"mediaUploadDialog"` — there is an `en` and a `uk` per the project's i18n), add under `components.mediaUploadDialog`:
```json
"quality": {
  "label": "Video quality",
  "low": "Low — 480p, smallest file",
  "standard": "Standard — 720p, plays on all devices",
  "high": "High — 1080p, larger, native players",
  "hint": "Applies to video uploads. High keeps 1080p for native-player boxes."
}
```
Add the Ukrainian equivalents in the `uk` file (translate the strings).

- [ ] **Step 4: Add the quality badge to media detail**

In `app/components/MediaDetailDrawer.vue`, where video metadata (resolution/duration) is shown, add a `UBadge` for `media.quality` (only for `kind === 'video'`):
```vue
<UBadge v-if="media.kind === 'video'" color="neutral" variant="subtle" size="sm">
  {{ media.quality }}
</UBadge>
```
(Bind to whatever the drawer calls its media object.)

- [ ] **Step 5: Build to verify it compiles + renders**

Run: `pnpm build`
Expected: BUILD succeeds. (Optionally `PORT=5100 pnpm dev` and confirm the upload dialog shows the selector and the FormData carries `quality` — DevTools network tab — but build + the Task 3 API tests are the gate.)

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS (unchanged — UI isn't unit-tested here).

- [ ] **Step 7: Commit**

```bash
git add app/components/MediaUploadDialog.vue app/components/MediaDetailDrawer.vue app/types/api.ts <locale files>
git commit -m "feat(media): quality preset selector on upload + quality badge"
```

---

## Self-Review

**Spec coverage:**
- Preset table (low/standard/high values) → Task 2 Step 3. ✓
- Parameterized `transcodeToKioskSafe` → Task 2. ✓
- `ensureKioskSafe`→`ensureQuality` always-encode + `isKioskSafe` retained → Task 2. ✓
- All callers updated (media.post, backfill, both test files) → Task 2 Step 4. ✓
- `quality` form field + default standard + invalid handling → Task 3 Step 3(f). ✓
- Dedup on `(source, quality)` → Task 3 Step 3(c). ✓
- Persist `quality` on row → Task 3 Step 3(e). ✓
- Schema column + composite index + migration → Task 1. ✓
- Upload selector + detail badge + types + i18n → Task 4. ✓
- Backward-compat (omit → standard) → Task 2 (media.post 'standard') then Task 3 (default). ✓
- Out-of-scope items (re-transcode, per-surface, configurable, surface warnings, image quality) → not implemented. ✓

**Placeholder scan:** No TBD/TODO. The UI task points the implementer to verify the exact `USelect` items-prop and locale file paths against the live code (the project's Nuxt UI version / i18n layout), which are concrete lookups, not deferred work.

**Type consistency:** `QualityPreset = 'low'|'standard'|'high'` and the `QUALITY_PRESETS` shape (`maxLong/maxShort/crf/audioBitrate`) are identical across Tasks 2-3. `ensureQuality(inPath, tmpDir, preset)` signature matches its caller in Task 2/3. `IngestInput.quality?` matches the handler's resolved `quality`. The `media.quality` column name matches the schema, dedup, insert, type, and badge.

---

## Execution Notes
- Order matters for a green build: Task 1 (schema, additive) → Task 2 (rename + callers, keeps build compiling) → Task 3 (wire the field) → Task 4 (UI). Each task ends green.
- The two real (already-running) transcodes in the Task 2 tests need ffmpeg/ffprobe present (they are, on this dev machine and in CI). Each has a 60s timeout.
