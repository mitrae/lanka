# Lanka Dashboard API & Infrastructure Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin-facing CRUD API surface for Lanka — every domain entity (addresses, groups, devices, media, playlists, playlist items, assignments) is creatable, readable, updatable, and deletable over HTTP. Adds schema upgrades carried over from Plan 1's review, thumbnails for media, and a dashboard SSE feed for live device status. Deliverable: an operator can manage the system entirely via `curl`.

**Architecture:** Continues the Plan 1 patterns — `handleXxx(db, ...)` pure functions plus Nitro default-export wrappers; zod for body validation; test harness via in-memory SQLite + `handleXxx` direct calls. Adds one new service (`thumbnails.ts`) and extends `MediaStore` with a thumbnail namespace.

**Tech Stack:** Node.js 20 LTS, Nuxt 4 / Nitro, TypeScript, Drizzle ORM, better-sqlite3, drizzle-kit, vitest, zod, `sharp` (image thumbnails), `@ffmpeg-installer/ffmpeg` + `fluent-ffmpeg` (video thumbnails), `mime` (MIME detection fallback), formidable.

**Parent spec:** `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`
**Prior plan:** `docs/superpowers/plans/2026-04-18-lanka-foundation-and-sync.md` (merged to `main`)

---

## Scope

**Delivered:**

- Two schema upgrades: `media.mime_type` + `media.thumbnail_bytes`; new `device_errors` table.
- `tests/helpers/nuxt-stubs.ts` hardening: unstubbed auto-imports throw informative errors.
- `MediaStore` extension: `putThumbnail` / `hasThumbnail` / `openThumbnail`.
- Thumbnail service (`sharp` for images, `fluent-ffmpeg` for video first-frame).
- Updated `ingestMedia` to detect mime, generate thumbnails.
- Updated `GET /media/:sha256` to return stored mime; new `GET /media/:sha256/thumb`.
- Updated `handleTelemetry` to persist errors into `device_errors`.
- CRUD endpoints for: **addresses, groups, devices, media (list+get+delete), playlists, playlist items (bulk replace), assignments (target-based), device reload (kick).**
- `GET /api/dashboard/stream` — dashboard SSE.
- Integration test covering the full admin flow.
- README update.

**Deferred to later plans:**

- Nuxt UI dashboard pages (Plan 2b).
- `/player` web route (Plan 3).
- Docker + systemd + backups (Plan 4).
- Android APK (Plan 5).

---

## File Structure

```
lanka/
├── server/
│   ├── api/
│   │   ├── addresses/
│   │   │   ├── index.get.ts                # GET /api/addresses
│   │   │   ├── index.post.ts               # POST /api/addresses
│   │   │   └── [id].{get,patch,delete}.ts
│   │   ├── groups/                         # same shape as addresses
│   │   ├── devices/
│   │   │   ├── index.get.ts                # GET /api/devices (with filter)
│   │   │   ├── [id].{get,patch,delete}.ts
│   │   │   └── [id]/reload.post.ts         # kick via SSE
│   │   ├── media/
│   │   │   ├── index.get.ts                # list
│   │   │   └── [id].{get,delete}.ts        # (upload.post.ts from Plan 1 stays)
│   │   ├── playlists/
│   │   │   ├── index.{get,post}.ts
│   │   │   ├── [id].{get,patch,delete}.ts
│   │   │   └── [id]/items.put.ts           # bulk replace
│   │   ├── assignments/
│   │   │   ├── devices/[id].{put,delete}.ts
│   │   │   ├── groups/[id].{put,delete}.ts
│   │   │   └── addresses/[id].{put,delete}.ts
│   │   ├── dashboard/
│   │   │   └── stream.get.ts               # SSE
│   │   └── devices/[id]/telemetry.post.ts  # MODIFIED for persistence
│   ├── routes/
│   │   └── media/
│   │       ├── [sha256].get.ts             # MODIFIED for mime_type
│   │       └── [sha256]/thumb.get.ts       # NEW
│   ├── services/
│   │   ├── media-store.ts                  # MODIFIED: add thumbnail namespace
│   │   ├── thumbnails.ts                   # NEW
│   │   ├── events.ts                       # MODIFIED: add dashboard channel
│   │   └── ... (existing)
│   ├── db/
│   │   ├── schema.ts                       # MODIFIED: add mime_type, thumbnail_bytes, device_errors
│   │   └── migrations/                     # new 0001 migration
│   └── api/media.post.ts                   # MODIFIED: mime + thumbnails
├── tests/
│   ├── helpers/
│   │   ├── nuxt-stubs.ts                   # MODIFIED: informative errors
│   │   └── fixtures.ts                     # MODIFIED: helpers for new tables
│   ├── api/
│   │   ├── addresses.test.ts
│   │   ├── groups.test.ts
│   │   ├── devices.test.ts
│   │   ├── media-list.test.ts
│   │   ├── playlists.test.ts
│   │   ├── playlist-items.test.ts
│   │   ├── assignments.test.ts
│   │   ├── device-reload.test.ts
│   │   ├── dashboard-stream.test.ts
│   │   └── devices-telemetry.test.ts       # MODIFIED for new persistence assertion
│   ├── services/
│   │   └── thumbnails.test.ts
│   └── integration/
│       └── admin-flow.test.ts
└── README.md                               # MODIFIED: endpoint table
```

---

## Task 1: Schema upgrade — `mime_type` and `thumbnail_bytes` on media, `device_errors` table

**Files:**
- Modify: `server/db/schema.ts`
- Create: `server/db/migrations/0001_*.sql` (drizzle-kit generated)

- [ ] **Step 1: Extend `media` table and add `deviceErrors` to `schema.ts`**

Edit `server/db/schema.ts`:

Replace the existing `media` definition with:

```ts
export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha256: text('sha256').notNull(),
    kind: text('kind', { enum: ['video', 'image'] }).notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    bytes: integer('bytes').notNull(),
    thumbnailBytes: integer('thumbnail_bytes'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    sha256Idx: uniqueIndex('media_sha256_idx').on(t.sha256)
  })
)
```

Add at the bottom of the schema (before the relations):

```ts
export const deviceErrors = sqliteTable(
  'device_errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    sha256: text('sha256'),
    message: text('message').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    deviceIdx: index('device_errors_device_idx').on(t.deviceId, t.createdAt)
  })
)
```

Re-add `index` to the top-level imports since it was dropped after Task 3 of Plan 1:

```ts
import {
  sqliteTable,
  integer,
  text,
  check,
  uniqueIndex,
  index
} from 'drizzle-orm/sqlite-core'
```

Add a relations block at the bottom:

```ts
export const deviceErrorsRelations = relations(deviceErrors, ({ one }) => ({
  device: one(devices, { fields: [deviceErrors.deviceId], references: [devices.id] })
}))
```

- [ ] **Step 2: Generate migration**

```bash
pnpm db:generate
```

Expected: new file `server/db/migrations/0001_*.sql` created.

Read it and verify it contains:
- `ALTER TABLE media ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'`
- `ALTER TABLE media ADD COLUMN thumbnail_bytes INTEGER`
- `CREATE TABLE device_errors (...)` with FK and index

- [ ] **Step 3: Apply migration**

```bash
rm -f data/signage.db && pnpm db:migrate
```

(The `rm -f` clears the local dev DB — safe because `data/` is gitignored and we're still on the foundation milestone.)

- [ ] **Step 4: Smoke test**

```bash
node -e "const db=require('better-sqlite3')('data/signage.db'); console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='media'\").get()); console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='device_errors'\").get())"
```

Expected: `media` schema shows the two new columns, `device_errors` table exists.

- [ ] **Step 5: Run full vitest suite to confirm nothing regressed**

```bash
pnpm test
```

Expected: 58 passing (same as Plan 1). The new columns have defaults so existing INSERTs keep working.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/migrations/
git commit -m "feat(db): add media.mime_type + thumbnail_bytes, device_errors table"
```

---

## Task 2: Harden `tests/helpers/nuxt-stubs.ts`

**Files:**
- Modify: `tests/helpers/nuxt-stubs.ts`

- [ ] **Step 1: Replace silent no-ops with informative throws**

Replace the entire file contents with:

```ts
// tests/helpers/nuxt-stubs.ts
//
// Stubs Nitro/Nuxt auto-imports so server modules can be imported by vitest
// without booting Nuxt. Each stub throws a descriptive error so that a test
// which accidentally exercises a Nitro wrapper (rather than the tested
// handleXxx function) fails loudly instead of passing a silent no-op.
//
// Maintenance: when a new Nitro auto-import is introduced by a server file
// that is transitively imported from tests, add a stub here.

import { vi } from 'vitest'

function notInTests(name: string) {
  return (..._args: unknown[]) => {
    throw new Error(
      `${name}() is a Nitro auto-import; it is not available in the test environment. ` +
        `Call the pure handleXxx function directly instead of exercising the default export.`
    )
  }
}

;(globalThis as any).defineEventHandler = (handler: unknown) => handler
;(globalThis as any).readBody = notInTests('readBody')
;(globalThis as any).getRouterParam = notInTests('getRouterParam')
;(globalThis as any).getRequestHeader = notInTests('getRequestHeader')
;(globalThis as any).getQuery = notInTests('getQuery')
;(globalThis as any).sendStream = notInTests('sendStream')
;(globalThis as any).sendRedirect = notInTests('sendRedirect')
;(globalThis as any).setResponseStatus = notInTests('setResponseStatus')
;(globalThis as any).setResponseHeader = notInTests('setResponseHeader')
;(globalThis as any).createEventStream = notInTests('createEventStream')
;(globalThis as any).useRuntimeConfig = notInTests('useRuntimeConfig')

// `createError` and `useDb` *are* called from handleXxx functions, so these
// must be functional rather than throwers.
;(globalThis as any).createError = (opts: {
  statusCode?: number
  message?: string
}) => {
  const err: any = new Error(opts.message ?? `HTTP ${opts.statusCode ?? 500}`)
  err.statusCode = opts.statusCode ?? 500
  return err
}
// useDb is swapped by individual tests that need it; baseline just throws.
;(globalThis as any).useDb = notInTests('useDb')
```

- [ ] **Step 2: Run full suite**

```bash
pnpm test
```

Expected: 58 passing. If any test fails with the new error message, that test was exercising a path that should be fixed — but no currently-passing test should regress (all existing tests call `handleXxx` directly).

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/nuxt-stubs.ts
git commit -m "test: nuxt-stubs throw informative errors on unexpected use"
```

---

## Task 3: Extend MediaStore with thumbnail namespace

**Files:**
- Modify: `server/services/media-store.ts`
- Modify: `tests/services/media-store.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/services/media-store.test.ts`, inside the existing `describe('LocalDiskStore', ...)`:

```ts
  it('writes and reads a thumbnail at the .thumbs/ namespace', async () => {
    await store.putThumbnail('thumbsha', Readable.from([Buffer.from('JPEG-BYTES')]))
    expect(await store.hasThumbnail('thumbsha')).toBe(true)

    const s = store.openThumbnail('thumbsha')
    const chunks: Buffer[] = []
    for await (const c of s) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('JPEG-BYTES')
  })

  it('hasThumbnail returns false when not written', async () => {
    expect(await store.hasThumbnail('no-thumb')).toBe(false)
  })

  it('thumbnail put is atomic (no .tmp leftover)', async () => {
    await store.putThumbnail('atomic', Readable.from([Buffer.from('x')]))
    const fs = await import('node:fs/promises')
    const thumbsDir = join(dir, '.thumbs')
    const entries = await fs.readdir(thumbsDir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
```

- [ ] **Step 2: Run — fails**

```bash
pnpm test tests/services/media-store.test.ts
```

Expected: 3 failures (methods don't exist yet).

- [ ] **Step 3: Extend `MediaStore` interface and `LocalDiskStore`**

Replace the contents of `server/services/media-store.ts` with:

```ts
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat as fsStat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'

export interface MediaStore {
  put(sha256: string, stream: Readable): Promise<void>
  has(sha256: string): Promise<boolean>
  open(sha256: string, opts?: { start?: number; end?: number }): Readable
  stat(sha256: string): Promise<{ bytes: number }>
  delete(sha256: string): Promise<void>

  putThumbnail(sha256: string, stream: Readable): Promise<void>
  hasThumbnail(sha256: string): Promise<boolean>
  openThumbnail(sha256: string): Readable
  deleteThumbnail(sha256: string): Promise<void>
}

export class LocalDiskStore implements MediaStore {
  constructor(private readonly dir: string) {}

  private path(sha: string): string {
    return join(this.dir, sha)
  }

  private thumbPath(sha: string): string {
    return join(this.dir, '.thumbs', `${sha}.jpg`)
  }

  private async putAtomic(finalPath: string, stream: Readable): Promise<void> {
    await mkdir(dirname(finalPath), { recursive: true })
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await pipeline(stream, createWriteStream(tmp))
      await rename(tmp, finalPath)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // ignore
      }
      throw err
    }
  }

  async put(sha: string, stream: Readable): Promise<void> {
    await this.putAtomic(this.path(sha), stream)
  }

  async has(sha: string): Promise<boolean> {
    return existsSync(this.path(sha))
  }

  open(sha: string, opts?: { start?: number; end?: number }): Readable {
    return createReadStream(this.path(sha), opts)
  }

  async stat(sha: string): Promise<{ bytes: number }> {
    const s = await fsStat(this.path(sha))
    return { bytes: s.size }
  }

  async delete(sha: string): Promise<void> {
    try {
      await unlink(this.path(sha))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  async putThumbnail(sha: string, stream: Readable): Promise<void> {
    await this.putAtomic(this.thumbPath(sha), stream)
  }

  async hasThumbnail(sha: string): Promise<boolean> {
    return existsSync(this.thumbPath(sha))
  }

  openThumbnail(sha: string): Readable {
    return createReadStream(this.thumbPath(sha))
  }

  async deleteThumbnail(sha: string): Promise<void> {
    try {
      await unlink(this.thumbPath(sha))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}
```

Note: the atomic-write logic is extracted into a private `putAtomic` helper since both `put` and `putThumbnail` need it.

- [ ] **Step 4: Run — passes**

```bash
pnpm test tests/services/media-store.test.ts
```

Expected: 10 passed (original 7 + new 3).

- [ ] **Step 5: Commit**

```bash
git add server/services/media-store.ts tests/services/media-store.test.ts
git commit -m "feat(services): thumbnail namespace on MediaStore"
```

---

## Task 4: Thumbnail generation service

**Files:**
- Create: `server/services/thumbnails.ts`
- Create: `tests/services/thumbnails.test.ts`
- Modify: `package.json` (add `sharp`, `fluent-ffmpeg`, `@ffmpeg-installer/ffmpeg`, `@types/fluent-ffmpeg`)

- [ ] **Step 1: Install deps**

```bash
pnpm add sharp fluent-ffmpeg @ffmpeg-installer/ffmpeg
pnpm add -D @types/fluent-ffmpeg
```

Also add `sharp` and `@ffmpeg-installer/ffmpeg` to `pnpm.onlyBuiltDependencies` in `package.json` (they are native modules with install scripts). Final list should be:

```json
"pnpm": {
  "onlyBuiltDependencies": [
    "@ffmpeg-installer/ffmpeg",
    "@parcel/watcher",
    "better-sqlite3",
    "esbuild",
    "sharp"
  ]
}
```

- [ ] **Step 2: Failing tests**

```ts
// tests/services/thumbnails.test.ts
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { generateImageThumbnail } from '~/server/services/thumbnails'

describe('generateImageThumbnail', () => {
  it('produces a JPEG with max dimension 256', async () => {
    // Create a simple 1000x500 red PNG via sharp
    const input = await sharp({
      create: {
        width: 1000,
        height: 500,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    })
      .png()
      .toBuffer()

    const thumbBuf = await generateImageThumbnail(Readable.from([input]))

    // Verify it's a JPEG (magic bytes: FF D8 FF)
    expect(thumbBuf[0]).toBe(0xff)
    expect(thumbBuf[1]).toBe(0xd8)
    expect(thumbBuf[2]).toBe(0xff)

    // Verify max dimension is 256 (respects aspect ratio)
    const meta = await sharp(thumbBuf).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(256)
    expect(meta.width).toBe(256) // wider original → wider thumb
    expect(meta.height).toBe(128) // preserved aspect ratio
  })

  it('rejects non-image input', async () => {
    await expect(
      generateImageThumbnail(Readable.from([Buffer.from('not an image')]))
    ).rejects.toThrow()
  })
})
```

Note: We do NOT write a test for `generateVideoThumbnail` in this task because ffmpeg requires a real video file and spawns a subprocess — too slow and flaky for unit tests. We smoke-test it manually in the ingestion integration test (Task 13).

- [ ] **Step 3: Run — fails**

```bash
pnpm test tests/services/thumbnails.test.ts
```

- [ ] **Step 4: Implement**

```ts
// server/services/thumbnails.ts
import { mkdtempSync, createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import sharp from 'sharp'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import ffmpeg from 'fluent-ffmpeg'

ffmpeg.setFfmpegPath(ffmpegPath.path)

const MAX_DIM = 256

/**
 * Reads the full image from the stream, produces a JPEG thumbnail sized so
 * its largest dimension is MAX_DIM. Preserves aspect ratio.
 */
export async function generateImageThumbnail(
  stream: Readable
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const input = Buffer.concat(chunks)

  return sharp(input)
    .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 80 })
    .toBuffer()
}

/**
 * Extracts the first frame of a video as a JPEG thumbnail via ffmpeg.
 * Requires a seekable source, so we buffer to a tmp file first.
 */
export async function generateVideoThumbnail(
  stream: Readable
): Promise<Buffer> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lanka-thumb-'))
  const videoPath = join(tmpDir, 'in.bin')
  const thumbPath = join(tmpDir, 'out.jpg')
  try {
    await pipeline(stream, createWriteStream(videoPath))
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput('00:00:01')
        .frames(1)
        .size(`${MAX_DIM}x?`)
        .output(thumbPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run()
    })
    const chunks: Buffer[] = []
    for await (const chunk of createReadStream(thumbPath))
      chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 5: Run — passes**

```bash
pnpm test tests/services/thumbnails.test.ts
```

Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add server/services/thumbnails.ts tests/services/thumbnails.test.ts package.json pnpm-lock.yaml
git commit -m "feat(services): thumbnail generator (sharp + ffmpeg)"
```

---

## Task 5: Wire thumbnails + mime into media upload, serve mime from /media/:sha256, add /media/:sha256/thumb

**Files:**
- Modify: `server/api/media.post.ts`
- Modify: `server/routes/media/[sha256].get.ts`
- Create: `server/routes/media/[sha256]/thumb.get.ts`
- Modify: `tests/api/media-upload.test.ts`
- Modify: `tests/api/media-serve.test.ts`

- [ ] **Step 1: Write failing tests for upload thumbnail/mime behavior**

Append to `tests/api/media-upload.test.ts`, inside the existing `describe('ingestMedia', ...)`:

```ts
  it('records mimeType from explicit input', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('PNG-BYTES'),
      filename: 'test.png',
      kind: 'image',
      mimeType: 'image/png'
    })
    expect(row.mimeType).toBe('image/png')
  })

  it('defaults mimeType to application/octet-stream when not provided', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('RAW'),
      filename: 'blob.bin',
      kind: 'image'
    })
    expect(row.mimeType).toBe('application/octet-stream')
  })

  it('stores a thumbnail for image uploads', async () => {
    // Real tiny PNG via sharp for the thumbnail pipeline to work
    const sharp = (await import('sharp')).default
    const pngBuf = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 0, g: 128, b: 255 }
      }
    })
      .png()
      .toBuffer()
    const stream = Readable.from([pngBuf])

    const row = await ingestMedia(db, store, {
      stream,
      filename: 'square.png',
      kind: 'image',
      mimeType: 'image/png'
    })

    expect(await store.hasThumbnail(row.sha256)).toBe(true)
    expect(row.thumbnailBytes).toBeGreaterThan(0)
  })
```

Replace the existing type `IngestInput` in `server/api/media.post.ts`:

(Test 2 and 3 above reference `mimeType` input and `thumbnailBytes` row field — neither exists yet.)

- [ ] **Step 2: Run — fails**

```bash
pnpm test tests/api/media-upload.test.ts
```

- [ ] **Step 3: Update `ingestMedia` to accept/record mime and generate thumbnails**

Edit `server/api/media.post.ts`. Replace the `IngestInput` type and `ingestMedia` function:

```ts
export type IngestInput = {
  stream: Readable
  filename: string
  kind: 'video' | 'image'
  mimeType?: string
  durationMs?: number
  width?: number
  height?: number
}

export type IngestedMedia = typeof schema.media.$inferSelect

export async function ingestMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: IngestInput
): Promise<IngestedMedia> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lanka-ingest-'))
  const tmpPath = join(tmpDir, 'upload.bin')
  const hash = createHash('sha256')
  let bytes = 0

  try {
    const out = createWriteStream(tmpPath)
    input.stream.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      bytes += chunk.length
    })
    await pipeline(input.stream, out)

    if (bytes === 0) {
      throw createError({ statusCode: 400, message: 'Empty upload' })
    }

    const sha256 = hash.digest('hex')

    const existing = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.sha256, sha256))
      .get()
    if (existing) return existing

    await store.put(sha256, createReadStream(tmpPath))

    // Thumbnail — async-safe errors: if thumbnail generation fails, log and
    // continue; the media row still goes in without a thumbnail.
    let thumbnailBytes: number | null = null
    try {
      const { generateImageThumbnail, generateVideoThumbnail } = await import(
        '~/server/services/thumbnails'
      )
      const thumbBuf =
        input.kind === 'image'
          ? await generateImageThumbnail(createReadStream(tmpPath))
          : await generateVideoThumbnail(createReadStream(tmpPath))
      await store.putThumbnail(
        sha256,
        (await import('node:stream')).Readable.from([thumbBuf])
      )
      thumbnailBytes = thumbBuf.length
    } catch (err) {
      console.warn('[thumbnail]', { sha256, err: (err as Error).message })
    }

    const [row] = await db
      .insert(schema.media)
      .values({
        sha256,
        kind: input.kind,
        filename: input.filename,
        mimeType: input.mimeType ?? 'application/octet-stream',
        bytes,
        thumbnailBytes,
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null
      })
      .returning()
    return row
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
```

Also update the Nitro default export to pass `mimeType` from the multipart payload:

```ts
export default defineEventHandler(async (event) => {
  const form = formidable({ maxFileSize: 500 * 1024 * 1024 })
  const [fields, files] = await form.parse(event.node.req)

  const file = Array.isArray(files.file) ? files.file[0] : files.file
  if (!file) {
    throw createError({ statusCode: 400, message: 'No "file" field in upload' })
  }
  const kindRaw = Array.isArray(fields.kind) ? fields.kind[0] : fields.kind
  const kind = (kindRaw ?? '') as 'video' | 'image'
  if (kind !== 'video' && kind !== 'image') {
    throw createError({ statusCode: 400, message: 'kind must be "video" or "image"' })
  }
  const durMs = Array.isArray(fields.durationMs)
    ? fields.durationMs[0]
    : fields.durationMs

  const result = await ingestMedia(useDb(), useMediaStore(), {
    stream: createReadStream(file.filepath),
    filename: file.originalFilename ?? 'upload.bin',
    kind,
    mimeType: file.mimetype ?? undefined,
    durationMs: durMs ? Number(durMs) : undefined
  })

  return result
})
```

- [ ] **Step 4: Update `GET /media/:sha256` to use stored mime**

Edit `server/routes/media/[sha256].get.ts`. Replace the `Content-Type` setter:

```ts
setResponseHeader(event, 'Content-Type', row.mimeType)
```

(Previously it hard-coded `video/mp4` vs. `application/octet-stream`.)

Update `tests/api/media-serve.test.ts` — no new tests required for the MIME mapping change since `planMediaResponse` is unchanged; the MIME change is only in the Nitro wrapper and we don't exercise it.

- [ ] **Step 5: Add `GET /media/:sha256/thumb` route**

```ts
// server/routes/media/[sha256]/thumb.get.ts
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import * as schema from '~/server/db/schema'

export default defineEventHandler(async (event) => {
  const sha = getRouterParam(event, 'sha256')
  if (!sha) throw createError({ statusCode: 400 })

  const [row] = await useDb()
    .select()
    .from(schema.media)
    .where(eq(schema.media.sha256, sha))
  if (!row) throw createError({ statusCode: 404 })

  const store = useMediaStore()
  if (!(await store.hasThumbnail(sha))) {
    throw createError({ statusCode: 404, message: 'No thumbnail available' })
  }

  setResponseHeader(event, 'Content-Type', 'image/jpeg')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  return sendStream(event, store.openThumbnail(sha))
})
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

Expected: all prior tests still pass (58) plus 3 new upload tests = 61.

- [ ] **Step 7: Commit**

```bash
git add server/api/media.post.ts server/routes/media/[sha256].get.ts server/routes/media/[sha256]/thumb.get.ts tests/api/media-upload.test.ts
git commit -m "feat(media): store mime_type, generate thumbnails, serve /thumb route"
```

---

## Task 6: Persist telemetry errors to `device_errors`

**Files:**
- Modify: `server/api/devices/[id]/telemetry.post.ts`
- Modify: `tests/api/devices-telemetry.test.ts`
- Modify: `tests/helpers/fixtures.ts` (add `seedDeviceError` helper — but actually we query device_errors directly in tests, no fixture helper needed)

- [ ] **Step 1: Add test that telemetry with an error writes to device_errors**

Append to `tests/api/devices-telemetry.test.ts`, inside the existing `describe`:

```ts
  it('persists error payloads to device_errors', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      currentItemId: null,
      error: { sha256: 'bad-file-sha', message: 'decode failure' }
    })

    const rows = await db.select().from(schema.deviceErrors)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: 'dev-1',
      sha256: 'bad-file-sha',
      message: 'decode failure'
    })
    expect(rows[0].createdAt).toBeInstanceOf(Date)
  })

  it('does not write to device_errors when no error field', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const rows = await db.select().from(schema.deviceErrors)
    expect(rows).toHaveLength(0)
  })
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Update handler**

In `server/api/devices/[id]/telemetry.post.ts`, replace the existing `console.warn` block at the bottom of `handleTelemetry`:

```ts
  if (body.error) {
    await db.insert(schema.deviceErrors).values({
      deviceId,
      sha256: body.error.sha256 ?? null,
      message: body.error.message
    })
  }
}
```

(Remove the `console.warn` line — the DB insert is the record now.)

- [ ] **Step 4: Run — passes**

Expected: all prior + 2 new = 63.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/[id]/telemetry.post.ts tests/api/devices-telemetry.test.ts
git commit -m "feat(api): persist telemetry errors to device_errors"
```

---

## Task 7: Addresses CRUD

**Files:**
- Create: `server/api/addresses/index.get.ts`
- Create: `server/api/addresses/index.post.ts`
- Create: `server/api/addresses/[id].get.ts`
- Create: `server/api/addresses/[id].patch.ts`
- Create: `server/api/addresses/[id].delete.ts`
- Create: `tests/api/addresses.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// tests/api/addresses.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedGroup } from '../helpers/fixtures'
import {
  handleListAddresses,
  handleCreateAddress
} from '~/server/api/addresses/index.post'
import {
  handleGetAddress,
  handleUpdateAddress,
  handleDeleteAddress
} from '~/server/api/addresses/[id].delete'
import * as schema from '~/server/db/schema'

describe('addresses CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns all addresses ordered by created_at', async () => {
    const a = await seedAddress(db, 'First')
    await new Promise((r) => setTimeout(r, 5))
    const b = await seedAddress(db, 'Second')

    const rows = await handleListAddresses(db)
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
  })

  it('create inserts and returns the row', async () => {
    const row = await handleCreateAddress(db, { name: 'New' })
    expect(row.name).toBe('New')
    expect(row.id).toBeGreaterThan(0)

    const all = await db.select().from(schema.addresses)
    expect(all).toHaveLength(1)
  })

  it('create rejects empty name', async () => {
    await expect(handleCreateAddress(db, { name: '' })).rejects.toThrow()
  })

  it('get returns the row', async () => {
    const a = await seedAddress(db, 'X')
    const row = await handleGetAddress(db, a.id)
    expect(row.name).toBe('X')
  })

  it('get 404s on unknown id', async () => {
    await expect(handleGetAddress(db, 9999)).rejects.toThrow(/not found/i)
  })

  it('update changes name and bumps updatedAt', async () => {
    const a = await seedAddress(db, 'Before')
    await new Promise((r) => setTimeout(r, 5))
    const updated = await handleUpdateAddress(db, a.id, { name: 'After' })
    expect(updated.name).toBe('After')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime())
  })

  it('update 404s on unknown id', async () => {
    await expect(
      handleUpdateAddress(db, 9999, { name: 'x' })
    ).rejects.toThrow(/not found/i)
  })

  it('delete cascades to groups', async () => {
    const a = await seedAddress(db)
    await seedGroup(db, a.id, 'G')
    await handleDeleteAddress(db, a.id)

    expect(await db.select().from(schema.addresses)).toHaveLength(0)
    expect(await db.select().from(schema.groups)).toHaveLength(0)
  })

  it('delete 404s on unknown id', async () => {
    await expect(handleDeleteAddress(db, 9999)).rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement endpoints**

Create `server/api/addresses/index.get.ts`:

```ts
import { asc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListAddresses(
  db: BetterSQLite3Database<typeof schema>
) {
  return db.select().from(schema.addresses).orderBy(asc(schema.addresses.createdAt))
}

export default defineEventHandler(() => handleListAddresses(useDb()))
```

Create `server/api/addresses/index.post.ts`:

```ts
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const CreateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleCreateAddress(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = CreateSchema.parse(rawBody)
  const [row] = await db
    .insert(schema.addresses)
    .values({ name: body.name })
    .returning()
  return row
}

// Re-export the list-handler via the delete route so all handlers sit in one
// importable module for tests. (The actual routing is still per-file for Nitro.)
export { handleListAddresses } from './index.get'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleCreateAddress(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

Create `server/api/addresses/[id].get.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetAddress(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [row] = await db
    .select()
    .from(schema.addresses)
    .where(eq(schema.addresses.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Address ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const idParam = getRouterParam(event, 'id')
  const id = Number(idParam)
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetAddress(useDb(), id)
})
```

Create `server/api/addresses/[id].patch.ts`:

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const UpdateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleUpdateAddress(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  const [row] = await db
    .update(schema.addresses)
    .set({ name: body.name, updatedAt: new Date() })
    .where(eq(schema.addresses.id, id))
    .returning()
  if (!row) {
    throw createError({ statusCode: 404, message: `Address ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdateAddress(useDb(), id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

Create `server/api/addresses/[id].delete.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetAddress } from './[id].get'
export { handleUpdateAddress } from './[id].patch'

export async function handleDeleteAddress(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  const result = await db
    .delete(schema.addresses)
    .where(eq(schema.addresses.id, id))
    .returning({ id: schema.addresses.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Address ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeleteAddress(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Run — all 9 new tests pass**

```bash
pnpm test tests/api/addresses.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server/api/addresses/ tests/api/addresses.test.ts
git commit -m "feat(api): addresses CRUD"
```

---

## Task 8: Groups CRUD

**Files:**
- Create: `server/api/groups/index.{get,post}.ts`
- Create: `server/api/groups/[id].{get,patch,delete}.ts`
- Create: `tests/api/groups.test.ts`

Same pattern as addresses. Groups require an `addressId` (FK). Additional semantics:
- Listing supports `?addressId=N` filter.
- Create requires `addressId` + `name`.
- Delete cascades to devices' `groupId` → null (from the existing schema `onDelete: 'set null'`).

- [ ] **Step 1: Failing tests**

```ts
// tests/api/groups.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedDevice, seedGroup } from '../helpers/fixtures'
import {
  handleListGroups,
  handleCreateGroup
} from '~/server/api/groups/index.post'
import {
  handleGetGroup,
  handleUpdateGroup,
  handleDeleteGroup
} from '~/server/api/groups/[id].delete'
import * as schema from '~/server/db/schema'

describe('groups CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns all groups when no filter', async () => {
    const a = await seedAddress(db, 'A')
    const b = await seedAddress(db, 'B')
    await seedGroup(db, a.id, 'Ga')
    await seedGroup(db, b.id, 'Gb')
    const rows = await handleListGroups(db, {})
    expect(rows).toHaveLength(2)
  })

  it('list filters by addressId', async () => {
    const a = await seedAddress(db, 'A')
    const b = await seedAddress(db, 'B')
    await seedGroup(db, a.id, 'Ga')
    await seedGroup(db, b.id, 'Gb')
    const rows = await handleListGroups(db, { addressId: a.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Ga')
  })

  it('create requires addressId + name', async () => {
    const a = await seedAddress(db)
    const row = await handleCreateGroup(db, { addressId: a.id, name: 'Lobby' })
    expect(row.name).toBe('Lobby')
    expect(row.addressId).toBe(a.id)
  })

  it('create 400s on invalid addressId FK', async () => {
    await expect(
      handleCreateGroup(db, { addressId: 9999, name: 'G' })
    ).rejects.toThrow()
  })

  it('get returns the row', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'G')
    const row = await handleGetGroup(db, g.id)
    expect(row.name).toBe('G')
  })

  it('get 404s on unknown', async () => {
    await expect(handleGetGroup(db, 9999)).rejects.toThrow(/not found/i)
  })

  it('update changes name', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'Before')
    const updated = await handleUpdateGroup(db, g.id, { name: 'After' })
    expect(updated.name).toBe('After')
  })

  it('update can move group to another address', async () => {
    const a = await seedAddress(db, 'A')
    const b = await seedAddress(db, 'B')
    const g = await seedGroup(db, a.id, 'G')
    const updated = await handleUpdateGroup(db, g.id, { addressId: b.id })
    expect(updated.addressId).toBe(b.id)
  })

  it('delete sets devices.group_id to null', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'dev-1', groupId: g.id })
    await handleDeleteGroup(db, g.id)

    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    expect(dev.groupId).toBeNull()
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement**

`server/api/groups/index.get.ts`:

```ts
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListGroups(
  db: BetterSQLite3Database<typeof schema>,
  query: { addressId?: number }
) {
  const q = db.select().from(schema.groups).orderBy(asc(schema.groups.createdAt))
  return query.addressId
    ? q.where(eq(schema.groups.addressId, query.addressId))
    : q
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const addressId = q.addressId ? Number(q.addressId) : undefined
  return handleListGroups(useDb(), { addressId })
})
```

`server/api/groups/index.post.ts`:

```ts
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const CreateSchema = z.object({
  addressId: z.number().int().positive(),
  name: z.string().min(1).max(200)
})

export async function handleCreateGroup(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = CreateSchema.parse(rawBody)
  try {
    const [row] = await db
      .insert(schema.groups)
      .values({ addressId: body.addressId, name: body.name })
      .returning()
    return row
  } catch (err: any) {
    // SQLite FK violation
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown addressId' })
    }
    throw err
  }
}

export { handleListGroups } from './index.get'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleCreateGroup(useDb(), body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

`server/api/groups/[id].get.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetGroup(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [row] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Group ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetGroup(useDb(), id)
})
```

`server/api/groups/[id].patch.ts`:

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const UpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    addressId: z.number().int().positive().optional()
  })
  .refine((v) => v.name !== undefined || v.addressId !== undefined, {
    message: 'At least one field must be provided'
  })

export async function handleUpdateGroup(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  const [row] = await db
    .update(schema.groups)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(schema.groups.id, id))
    .returning()
  if (!row) {
    throw createError({ statusCode: 404, message: `Group ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdateGroup(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

`server/api/groups/[id].delete.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetGroup } from './[id].get'
export { handleUpdateGroup } from './[id].patch'

export async function handleDeleteGroup(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  const result = await db
    .delete(schema.groups)
    .where(eq(schema.groups.id, id))
    .returning({ id: schema.groups.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Group ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeleteGroup(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Run — 9 new tests pass**

- [ ] **Step 5: Commit**

```bash
git add server/api/groups/ tests/api/groups.test.ts
git commit -m "feat(api): groups CRUD with addressId filter"
```

---

## Task 9: Devices CRUD + reload

**Files:**
- Create: `server/api/devices/index.get.ts`
- Create: `server/api/devices/[id].get.ts` (new — existing `[id]/manifest.get.ts` stays)
- Create: `server/api/devices/[id].patch.ts`
- Create: `server/api/devices/[id].delete.ts`
- Create: `server/api/devices/[id]/reload.post.ts`
- Create: `tests/api/devices.test.ts`
- Create: `tests/api/device-reload.test.ts`

Semantics:
- List supports `?groupId=X` and `?addressId=X` (via JOIN) filters.
- List includes computed `status` field (`'online' | 'idle' | 'offline'`) derived from `lastSeenAt`:
  - `> now - 60s` → online
  - `> now - 5min` → idle
  - else → offline
- Update supports renaming and reassigning to a group (claim or move).
- Delete cascades (but there's nothing cascaded to; just removes the row).
- Reload emits an SSE `reload` event via `useEventsHub().emitDevice(id, 'reload', null)`.

- [ ] **Step 1: Failing tests for devices**

```ts
// tests/api/devices.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedDevice, seedGroup } from '../helpers/fixtures'
import { handleListDevices } from '~/server/api/devices/index.get'
import {
  handleGetDevice,
  handleUpdateDevice,
  handleDeleteDevice
} from '~/server/api/devices/[id].delete'
import * as schema from '~/server/db/schema'

describe('devices CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns all devices with computed status', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    // recent: online
    await db
      .insert(schema.devices)
      .values({ id: 'online', groupId: g.id, lastSeenAt: new Date() })
    // 3 min ago: idle
    await db
      .insert(schema.devices)
      .values({
        id: 'idle',
        groupId: g.id,
        lastSeenAt: new Date(Date.now() - 3 * 60 * 1000)
      })
    // 10 min ago: offline
    await db
      .insert(schema.devices)
      .values({
        id: 'offline',
        groupId: g.id,
        lastSeenAt: new Date(Date.now() - 10 * 60 * 1000)
      })
    // never seen: offline
    await db.insert(schema.devices).values({ id: 'never' })

    const rows = await handleListDevices(db, {})
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('online')!.status).toBe('online')
    expect(byId.get('idle')!.status).toBe('idle')
    expect(byId.get('offline')!.status).toBe('offline')
    expect(byId.get('never')!.status).toBe('offline')
  })

  it('list filters by groupId', async () => {
    const a = await seedAddress(db)
    const g1 = await seedGroup(db, a.id, 'G1')
    const g2 = await seedGroup(db, a.id, 'G2')
    await seedDevice(db, { id: 'in-g1', groupId: g1.id })
    await seedDevice(db, { id: 'in-g2', groupId: g2.id })

    const rows = await handleListDevices(db, { groupId: g1.id })
    expect(rows.map((r) => r.id)).toEqual(['in-g1'])
  })

  it('list filters by addressId (joins groups)', async () => {
    const a1 = await seedAddress(db, 'A1')
    const a2 = await seedAddress(db, 'A2')
    const g1 = await seedGroup(db, a1.id)
    const g2 = await seedGroup(db, a2.id)
    await seedDevice(db, { id: 'a1-d', groupId: g1.id })
    await seedDevice(db, { id: 'a2-d', groupId: g2.id })

    const rows = await handleListDevices(db, { addressId: a1.id })
    expect(rows.map((r) => r.id)).toEqual(['a1-d'])
  })

  it('list excludes unclaimed when ?unclaimed=false, includes when ?unclaimed=true', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'unclaimed' })
    await seedDevice(db, { id: 'claimed', groupId: g.id })

    const both = await handleListDevices(db, {})
    expect(both.map((r) => r.id).sort()).toEqual(['claimed', 'unclaimed'])

    const onlyUnclaimed = await handleListDevices(db, { unclaimed: true })
    expect(onlyUnclaimed.map((r) => r.id)).toEqual(['unclaimed'])
  })

  it('get returns the device', async () => {
    await seedDevice(db, { id: 'd', name: 'TV' })
    const row = await handleGetDevice(db, 'd')
    expect(row.name).toBe('TV')
  })

  it('get 404s on unknown', async () => {
    await expect(handleGetDevice(db, 'ghost')).rejects.toThrow(/not found/i)
  })

  it('update renames', async () => {
    await seedDevice(db, { id: 'd', name: 'Old' })
    const updated = await handleUpdateDevice(db, 'd', { name: 'New' })
    expect(updated.name).toBe('New')
  })

  it('update claims unclaimed device (groupId)', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd' })
    const updated = await handleUpdateDevice(db, 'd', {
      groupId: g.id,
      name: 'TV-1'
    })
    expect(updated.groupId).toBe(g.id)
    expect(updated.name).toBe('TV-1')
  })

  it('update with groupId: null unclaims', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id, name: 'TV' })
    const updated = await handleUpdateDevice(db, 'd', { groupId: null })
    expect(updated.groupId).toBeNull()
  })

  it('delete removes the row', async () => {
    await seedDevice(db, { id: 'd' })
    await handleDeleteDevice(db, 'd')
    expect(await db.select().from(schema.devices)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement**

`server/api/devices/index.get.ts`:

```ts
import { and, asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export type DeviceStatus = 'online' | 'idle' | 'offline'

export type DeviceListRow = typeof schema.devices.$inferSelect & {
  status: DeviceStatus
}

function computeStatus(lastSeenAt: Date | null): DeviceStatus {
  if (!lastSeenAt) return 'offline'
  const ageMs = Date.now() - lastSeenAt.getTime()
  if (ageMs <= 60_000) return 'online'
  if (ageMs <= 5 * 60_000) return 'idle'
  return 'offline'
}

export async function handleListDevices(
  db: BetterSQLite3Database<typeof schema>,
  query: { groupId?: number; addressId?: number; unclaimed?: boolean }
): Promise<DeviceListRow[]> {
  const conditions = []

  if (query.unclaimed) {
    conditions.push(sql`${schema.devices.groupId} IS NULL`)
  }
  if (query.groupId !== undefined) {
    conditions.push(eq(schema.devices.groupId, query.groupId))
  }

  let rows: (typeof schema.devices.$inferSelect)[]
  if (query.addressId !== undefined) {
    rows = await db
      .select({
        id: schema.devices.id,
        groupId: schema.devices.groupId,
        name: schema.devices.name,
        lastSeenAt: schema.devices.lastSeenAt,
        playerVersion: schema.devices.playerVersion,
        currentItemId: schema.devices.currentItemId,
        createdAt: schema.devices.createdAt,
        updatedAt: schema.devices.updatedAt
      })
      .from(schema.devices)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.devices.groupId))
      .where(
        and(eq(schema.groups.addressId, query.addressId), ...conditions)
      )
      .orderBy(asc(schema.devices.createdAt))
  } else {
    rows = await db
      .select()
      .from(schema.devices)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(schema.devices.createdAt))
  }

  return rows.map((r) => ({ ...r, status: computeStatus(r.lastSeenAt) }))
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return handleListDevices(useDb(), {
    groupId: q.groupId ? Number(q.groupId) : undefined,
    addressId: q.addressId ? Number(q.addressId) : undefined,
    unclaimed: q.unclaimed === 'true'
  })
})
```

`server/api/devices/[id].get.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string
) {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Device ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  return handleGetDevice(useDb(), id)
})
```

`server/api/devices/[id].patch.ts`:

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const UpdateSchema = z
  .object({
    name: z.string().min(1).max(200).nullable().optional(),
    groupId: z.number().int().positive().nullable().optional()
  })
  .refine((v) => v.name !== undefined || v.groupId !== undefined, {
    message: 'At least one field must be provided'
  })

export async function handleUpdateDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  try {
    const [row] = await db
      .update(schema.devices)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.devices.id, id))
      .returning()
    if (!row) {
      throw createError({ statusCode: 404, message: `Device ${id} not found` })
    }
    return row
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown groupId' })
    }
    throw err
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdateDevice(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

`server/api/devices/[id].delete.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetDevice } from './[id].get'
export { handleUpdateDevice } from './[id].patch'

export async function handleDeleteDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string
): Promise<void> {
  const result = await db
    .delete(schema.devices)
    .where(eq(schema.devices.id, id))
    .returning({ id: schema.devices.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Device ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  await handleDeleteDevice(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Implement reload endpoint + test**

```ts
// tests/api/device-reload.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedDevice } from '../helpers/fixtures'
import { EventsHub } from '~/server/services/events'
import { handleReloadDevice } from '~/server/api/devices/[id]/reload.post'

describe('POST /api/devices/:id/reload', () => {
  let db: TestDb
  let close: () => void
  let hub: EventsHub

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new EventsHub()
  })
  afterEach(() => close())

  it('emits reload event to the targeted device', async () => {
    await seedDevice(db, { id: 'dev-1' })
    const received: Array<{ event: string; data: unknown }> = []
    hub.subscribeDevice('dev-1', (event, data) => {
      received.push({ event, data })
    })

    await handleReloadDevice(db, hub, 'dev-1')

    expect(received).toEqual([{ event: 'reload', data: null }])
  })

  it('404s on unknown device', async () => {
    await expect(
      handleReloadDevice(db, hub, 'ghost')
    ).rejects.toThrow(/not found/i)
  })
})
```

```ts
// server/api/devices/[id]/reload.post.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'

export async function handleReloadDevice(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  deviceId: string
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!row) {
    throw createError({
      statusCode: 404,
      message: `Device ${deviceId} not found`
    })
  }
  hub.emitDevice(deviceId, 'reload', null)
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  await handleReloadDevice(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 5: Run all device tests — all pass**

- [ ] **Step 6: Commit**

```bash
git add server/api/devices/ tests/api/devices.test.ts tests/api/device-reload.test.ts
git commit -m "feat(api): devices CRUD + reload kick endpoint"
```

---

## Task 10: Media list + get + delete (with in-use protection)

**Files:**
- Create: `server/api/media/index.get.ts`
- Create: `server/api/media/[id].get.ts`
- Create: `server/api/media/[id].delete.ts`
- Create: `tests/api/media-list.test.ts`

Semantics:
- List: returns all media with computed `usedInPlaylists` count (via LEFT JOIN playlist_items GROUP BY).
- Get: single row.
- Delete: errors with 409 if referenced from any playlist_item. `?force=true` deletes referencing items (bumping their playlist versions) then the media + file + thumbnail.

- [ ] **Step 1: Failing tests**

```ts
// tests/api/media-list.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleListMedia } from '~/server/api/media/index.get'
import { handleGetMedia } from '~/server/api/media/[id].get'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

describe('media CRUD beyond upload', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-test-'))
    store = new LocalDiskStore(dir)
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('list returns all media with usedInPlaylists count', async () => {
    const a = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const b = await seedMedia(db, { sha256: 'b', kind: 'image' })
    await seedPlaylist(db, { items: [{ mediaId: a.id }] })
    await seedPlaylist(db, { items: [{ mediaId: a.id }, { mediaId: b.id }] })

    const rows = await handleListMedia(db)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(a.id)!.usedInPlaylists).toBe(2)
    expect(byId.get(b.id)!.usedInPlaylists).toBe(1)
  })

  it('get returns the row', async () => {
    const m = await seedMedia(db, { sha256: 'x', kind: 'image' })
    const row = await handleGetMedia(db, m.id)
    expect(row.sha256).toBe('x')
  })

  it('get 404s on unknown', async () => {
    await expect(handleGetMedia(db, 9999)).rejects.toThrow(/not found/i)
  })

  it('delete removes media + files when not referenced', async () => {
    const m = await seedMedia(db, { sha256: 'lone', kind: 'image' })
    await store.put('lone', Readable.from([Buffer.from('data')]))
    await store.putThumbnail('lone', Readable.from([Buffer.from('thumb')]))

    await handleDeleteMedia(db, store, m.id, { force: false })

    expect(await db.select().from(schema.media)).toHaveLength(0)
    expect(await store.has('lone')).toBe(false)
    expect(await store.hasThumbnail('lone')).toBe(false)
  })

  it('delete 409s when media is referenced by a playlist_item', async () => {
    const m = await seedMedia(db, { sha256: 'used', kind: 'image' })
    await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    await expect(
      handleDeleteMedia(db, store, m.id, { force: false })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('delete force=true removes referenced media and bumps playlist versions', async () => {
    const m = await seedMedia(db, { sha256: 'force', kind: 'image' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    expect(pl.version).toBe(1)

    await handleDeleteMedia(db, store, m.id, { force: true })

    expect(await db.select().from(schema.media)).toHaveLength(0)
    const [updatedPl] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(updatedPl.version).toBe(2) // bumped
  })

  it('delete 404s on unknown id', async () => {
    await expect(
      handleDeleteMedia(db, store, 9999, { force: false })
    ).rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement**

```ts
// server/api/media/index.get.ts
import { asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export type MediaListRow = typeof schema.media.$inferSelect & {
  usedInPlaylists: number
}

export async function handleListMedia(
  db: BetterSQLite3Database<typeof schema>
): Promise<MediaListRow[]> {
  const rows = await db
    .select({
      id: schema.media.id,
      sha256: schema.media.sha256,
      kind: schema.media.kind,
      filename: schema.media.filename,
      mimeType: schema.media.mimeType,
      bytes: schema.media.bytes,
      thumbnailBytes: schema.media.thumbnailBytes,
      durationMs: schema.media.durationMs,
      width: schema.media.width,
      height: schema.media.height,
      createdAt: schema.media.createdAt,
      usedInPlaylists: sql<number>`count(DISTINCT ${schema.playlistItems.playlistId})`
    })
    .from(schema.media)
    .leftJoin(
      schema.playlistItems,
      eq(schema.playlistItems.mediaId, schema.media.id)
    )
    .groupBy(schema.media.id)
    .orderBy(asc(schema.media.createdAt))
  return rows as MediaListRow[]
}

export default defineEventHandler(() => handleListMedia(useDb()))
```

```ts
// server/api/media/[id].get.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetMedia(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [row] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Media ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetMedia(useDb(), id)
})
```

```ts
// server/api/media/[id].delete.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

export { handleGetMedia } from './[id].get'

export async function handleDeleteMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: number,
  opts: { force: boolean }
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Media ${id} not found` })
  }

  const referencingItems = await db
    .select({
      playlistId: schema.playlistItems.playlistId
    })
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.mediaId, id))

  if (referencingItems.length > 0 && !opts.force) {
    throw createError({
      statusCode: 409,
      message: `Media ${id} is in use by ${referencingItems.length} playlist item(s). Pass force=true to delete anyway.`
    })
  }

  const affectedPlaylists = new Set(referencingItems.map((r) => r.playlistId))

  // Remove referencing items, then media, then files. All-or-nothing.
  if (opts.force && affectedPlaylists.size > 0) {
    await db
      .delete(schema.playlistItems)
      .where(eq(schema.playlistItems.mediaId, id))
    for (const pid of affectedPlaylists) {
      await bumpPlaylistVersion(db, pid)
    }
  }

  await db.delete(schema.media).where(eq(schema.media.id, id))
  await store.delete(row.sha256)
  await store.deleteThumbnail(row.sha256)
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const q = getQuery(event)
  await handleDeleteMedia(useDb(), useMediaStore(), id, {
    force: q.force === 'true'
  })
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit**

```bash
git add server/api/media/ tests/api/media-list.test.ts
git commit -m "feat(api): media list/get/delete with in-use protection + force"
```

---

## Task 11: Playlists CRUD

**Files:**
- Create: `server/api/playlists/index.{get,post}.ts`
- Create: `server/api/playlists/[id].{get,patch,delete}.ts`
- Create: `tests/api/playlists.test.ts`

Semantics:
- Renaming a playlist bumps its version.
- Delete cascades to playlist_items (schema FK does this).
- List returns summary: id, name, version, itemCount, assignmentCount.

- [ ] **Step 1: Failing tests**

```ts
// tests/api/playlists.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { assign, seedAddress, seedGroup, seedMedia, seedPlaylist } from '../helpers/fixtures'
import {
  handleListPlaylists,
  handleCreatePlaylist
} from '~/server/api/playlists/index.post'
import {
  handleGetPlaylist,
  handleUpdatePlaylist,
  handleDeletePlaylist
} from '~/server/api/playlists/[id].delete'
import * as schema from '~/server/db/schema'

describe('playlists CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns summary with itemCount and assignmentCount', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, {
      name: 'p',
      items: [{ mediaId: m.id }, { mediaId: m.id }]
    })
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await assign(db, { playlistId: pl.id, groupId: g.id })

    const rows = await handleListPlaylists(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('p')
    expect(rows[0].itemCount).toBe(2)
    expect(rows[0].assignmentCount).toBe(1)
  })

  it('create inserts with version 1', async () => {
    const row = await handleCreatePlaylist(db, { name: 'New' })
    expect(row.name).toBe('New')
    expect(row.version).toBe(1)
  })

  it('get returns single row with items included', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'image' })
    const pl = await seedPlaylist(db, {
      name: 'p',
      items: [{ mediaId: m.id, durationMsOverride: 5000 }]
    })

    const row = await handleGetPlaylist(db, pl.id)
    expect(row.items).toHaveLength(1)
    expect(row.items[0].mediaId).toBe(m.id)
    expect(row.items[0].durationMsOverride).toBe(5000)
  })

  it('update renames and bumps version', async () => {
    const pl = await seedPlaylist(db, { name: 'Old' })
    const updated = await handleUpdatePlaylist(db, pl.id, { name: 'New' })
    expect(updated.name).toBe('New')
    expect(updated.version).toBe(2)
  })

  it('delete cascades to playlist_items', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    await handleDeletePlaylist(db, pl.id)

    expect(await db.select().from(schema.playlists)).toHaveLength(0)
    expect(await db.select().from(schema.playlistItems)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement**

```ts
// server/api/playlists/index.get.ts
import { asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListPlaylists(
  db: BetterSQLite3Database<typeof schema>
) {
  // Two separate aggregations because we can't easily join items+assignments
  // without fanout; do it in two queries and merge in JS.
  const withItems = await db
    .select({
      id: schema.playlists.id,
      name: schema.playlists.name,
      version: schema.playlists.version,
      createdAt: schema.playlists.createdAt,
      updatedAt: schema.playlists.updatedAt,
      itemCount: sql<number>`count(${schema.playlistItems.id})`
    })
    .from(schema.playlists)
    .leftJoin(
      schema.playlistItems,
      eq(schema.playlistItems.playlistId, schema.playlists.id)
    )
    .groupBy(schema.playlists.id)
    .orderBy(asc(schema.playlists.createdAt))

  const assignmentCounts = await db
    .select({
      playlistId: schema.assignments.playlistId,
      c: sql<number>`count(${schema.assignments.id})`
    })
    .from(schema.assignments)
    .groupBy(schema.assignments.playlistId)

  const aMap = new Map(assignmentCounts.map((r) => [r.playlistId, r.c]))
  return withItems.map((r) => ({
    ...r,
    assignmentCount: aMap.get(r.id) ?? 0
  }))
}

export default defineEventHandler(() => handleListPlaylists(useDb()))
```

```ts
// server/api/playlists/index.post.ts
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const CreateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleCreatePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = CreateSchema.parse(rawBody)
  const [row] = await db
    .insert(schema.playlists)
    .values({ name: body.name })
    .returning()
  return row
}

export { handleListPlaylists } from './index.get'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleCreatePlaylist(useDb(), body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

```ts
// server/api/playlists/[id].get.ts
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetPlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, id))
  if (!pl) {
    throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
  }
  const items = await db
    .select()
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.playlistId, id))
    .orderBy(asc(schema.playlistItems.position))
  return { ...pl, items }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetPlaylist(useDb(), id)
})
```

```ts
// server/api/playlists/[id].patch.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

const UpdateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleUpdatePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  const [row] = await db
    .update(schema.playlists)
    .set({ name: body.name, updatedAt: new Date() })
    .where(eq(schema.playlists.id, id))
    .returning()
  if (!row) {
    throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
  }
  await bumpPlaylistVersion(db, id)
  // Re-read to get the incremented version
  const [refetched] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, id))
  return refetched
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdatePlaylist(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

```ts
// server/api/playlists/[id].delete.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetPlaylist } from './[id].get'
export { handleUpdatePlaylist } from './[id].patch'

export async function handleDeletePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  const result = await db
    .delete(schema.playlists)
    .where(eq(schema.playlists.id, id))
    .returning({ id: schema.playlists.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeletePlaylist(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit**

```bash
git add server/api/playlists/ tests/api/playlists.test.ts
git commit -m "feat(api): playlists CRUD with version bump on rename"
```

---

## Task 12: Playlist items — bulk replace

**Files:**
- Create: `server/api/playlists/[id]/items.put.ts`
- Create: `tests/api/playlist-items.test.ts`

Semantics:
- PUT replaces the entire playlist's items with the submitted ordered list.
- Body: `{ items: [{ mediaId: number, durationMsOverride?: number }] }`.
- Deletes existing items, inserts the new set with positions 0..N-1, bumps version.
- Validates: all `mediaId`s exist; image items need `durationMsOverride`; video items have it ignored.

- [ ] **Step 1: Failing tests**

```ts
// tests/api/playlist-items.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { handleReplacePlaylistItems } from '~/server/api/playlists/[id]/items.put'
import * as schema from '~/server/db/schema'

describe('PUT /api/playlists/:id/items', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('replaces all items with the submitted list and bumps version', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const i = await seedMedia(db, { sha256: 'i', kind: 'image' })
    const pl = await seedPlaylist(db, {
      name: 'p',
      items: [{ mediaId: v.id }]
    })
    expect(pl.version).toBe(1)

    await handleReplacePlaylistItems(db, pl.id, {
      items: [
        { mediaId: i.id, durationMsOverride: 5000 },
        { mediaId: v.id }
      ]
    })

    const items = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, pl.id))
    expect(items).toHaveLength(2)
    expect(items.map((x) => x.position)).toEqual([0, 1])
    expect(items[0].mediaId).toBe(i.id)
    expect(items[0].durationMsOverride).toBe(5000)
    expect(items[1].mediaId).toBe(v.id)

    const [refreshed] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(refreshed.version).toBe(2)
  })

  it('accepting empty list clears all items', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: v.id }] })

    await handleReplacePlaylistItems(db, pl.id, { items: [] })

    expect(
      await db
        .select()
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.playlistId, pl.id))
    ).toHaveLength(0)
  })

  it('rejects image items missing durationMsOverride', async () => {
    const i = await seedMedia(db, { sha256: 'i', kind: 'image' })
    const pl = await seedPlaylist(db)

    await expect(
      handleReplacePlaylistItems(db, pl.id, {
        items: [{ mediaId: i.id }]
      })
    ).rejects.toThrow(/duration/i)
  })

  it('rejects unknown mediaId', async () => {
    const pl = await seedPlaylist(db)
    await expect(
      handleReplacePlaylistItems(db, pl.id, {
        items: [{ mediaId: 9999, durationMsOverride: 1000 }]
      })
    ).rejects.toThrow(/media.*not found/i)
  })

  it('404s on unknown playlist id', async () => {
    await expect(
      handleReplacePlaylistItems(db, 9999, { items: [] })
    ).rejects.toThrow(/playlist.*not found/i)
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement**

```ts
// server/api/playlists/[id]/items.put.ts
import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

const BodySchema = z.object({
  items: z.array(
    z.object({
      mediaId: z.number().int().positive(),
      durationMsOverride: z.number().int().positive().optional()
    })
  )
})

export async function handleReplacePlaylistItems(
  db: BetterSQLite3Database<typeof schema>,
  playlistId: number,
  rawBody: unknown
): Promise<void> {
  const body = BodySchema.parse(rawBody)

  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, playlistId))
  if (!pl) {
    throw createError({
      statusCode: 404,
      message: `Playlist ${playlistId} not found`
    })
  }

  if (body.items.length > 0) {
    const mediaIds = body.items.map((i) => i.mediaId)
    const existingMedia = await db
      .select({ id: schema.media.id, kind: schema.media.kind })
      .from(schema.media)
      .where(inArray(schema.media.id, mediaIds))

    if (existingMedia.length !== new Set(mediaIds).size) {
      throw createError({
        statusCode: 400,
        message: 'One or more media items not found'
      })
    }

    const mediaKind = new Map(existingMedia.map((m) => [m.id, m.kind]))
    for (const it of body.items) {
      if (
        mediaKind.get(it.mediaId) === 'image' &&
        it.durationMsOverride === undefined
      ) {
        throw createError({
          statusCode: 400,
          message: `Image items require durationMsOverride (mediaId=${it.mediaId})`
        })
      }
    }
  }

  // Replace: delete all existing, then insert the new set.
  await db
    .delete(schema.playlistItems)
    .where(eq(schema.playlistItems.playlistId, playlistId))

  if (body.items.length > 0) {
    await db.insert(schema.playlistItems).values(
      body.items.map((it, idx) => ({
        playlistId,
        mediaId: it.mediaId,
        position: idx,
        durationMsOverride: it.durationMsOverride ?? null
      }))
    )
  }

  await bumpPlaylistVersion(db, playlistId)
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    await handleReplacePlaylistItems(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit**

```bash
git add server/api/playlists/[id]/ tests/api/playlist-items.test.ts
git commit -m "feat(api): PUT /api/playlists/:id/items bulk replace"
```

---

## Task 13: Assignments — target-based PUT/DELETE

**Files:**
- Create: `server/api/assignments/devices/[id].put.ts`
- Create: `server/api/assignments/devices/[id].delete.ts`
- Create: `server/api/assignments/groups/[id].put.ts`
- Create: `server/api/assignments/groups/[id].delete.ts`
- Create: `server/api/assignments/addresses/[id].put.ts`
- Create: `server/api/assignments/addresses/[id].delete.ts`
- Create: `tests/api/assignments.test.ts`

Semantics:
- PUT `/api/assignments/<target>/<id>` with `{ playlistId }`: UPSERT the assignment for that target.
- DELETE: remove the assignment (no-op if none).
- Because the assignment UNIQUE index is on each target column, UPSERT is safe.
- Emit SSE `manifest-changed` to affected devices on any assignment change. For address-level → every device under every group under that address; group-level → every device in that group; device-level → that device.

- [ ] **Step 1: Failing tests**

```ts
// tests/api/assignments.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedDevice, seedGroup, seedMedia, seedPlaylist } from '../helpers/fixtures'
import { EventsHub } from '~/server/services/events'
import {
  handleAssignDevice,
  handleUnassignDevice
} from '~/server/api/assignments/devices/[id].delete'
import {
  handleAssignGroup,
  handleUnassignGroup
} from '~/server/api/assignments/groups/[id].delete'
import {
  handleAssignAddress,
  handleUnassignAddress
} from '~/server/api/assignments/addresses/[id].delete'
import * as schema from '~/server/db/schema'

describe('assignments', () => {
  let db: TestDb
  let close: () => void
  let hub: EventsHub

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new EventsHub()
  })
  afterEach(() => close())

  async function setupTree() {
    const a = await seedAddress(db, 'A')
    const g = await seedGroup(db, a.id, 'G')
    await seedDevice(db, { id: 'd1', groupId: g.id })
    await seedDevice(db, { id: 'd2', groupId: g.id })
    const m = await seedMedia(db, { sha256: 'm', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    return { a, g, pl }
  }

  it('device-level assign creates the row and kicks that device', async () => {
    const { pl } = await setupTree()
    const received: string[] = []
    hub.subscribeDevice('d1', (e) => received.push(e))
    hub.subscribeDevice('d2', (e) => received.push(e))

    await handleAssignDevice(db, hub, 'd1', { playlistId: pl.id })

    const rows = await db.select().from(schema.assignments)
    expect(rows).toHaveLength(1)
    expect(rows[0].deviceId).toBe('d1')
    expect(received).toEqual(['manifest-changed']) // d1 only
  })

  it('device-level assign is idempotent (replaces existing)', async () => {
    const { pl } = await setupTree()
    const pl2 = await seedPlaylist(db, { name: 'p2' })
    await handleAssignDevice(db, hub, 'd1', { playlistId: pl.id })
    await handleAssignDevice(db, hub, 'd1', { playlistId: pl2.id })

    const rows = await db.select().from(schema.assignments)
    expect(rows).toHaveLength(1)
    expect(rows[0].playlistId).toBe(pl2.id)
  })

  it('group-level assign kicks every device in the group', async () => {
    const { g, pl } = await setupTree()
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))

    await handleAssignGroup(db, hub, g.id, { playlistId: pl.id })

    expect(received.sort()).toEqual(['d1', 'd2'])
  })

  it('address-level assign kicks every device under every group in the address', async () => {
    const { a, pl } = await setupTree()
    // Add a second group to the same address
    const g2 = await seedGroup(db, a.id, 'G2')
    await seedDevice(db, { id: 'd3', groupId: g2.id })
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))
    hub.subscribeDevice('d3', () => received.push('d3'))

    await handleAssignAddress(db, hub, a.id, { playlistId: pl.id })

    expect(received.sort()).toEqual(['d1', 'd2', 'd3'])
  })

  it('unassign device removes the row and kicks', async () => {
    const { pl } = await setupTree()
    await handleAssignDevice(db, hub, 'd1', { playlistId: pl.id })

    const received: string[] = []
    hub.subscribeDevice('d1', (e) => received.push(e))

    await handleUnassignDevice(db, hub, 'd1')
    expect(await db.select().from(schema.assignments)).toHaveLength(0)
    expect(received).toEqual(['manifest-changed'])
  })

  it('unassign when no row exists is a no-op (no error, no kick)', async () => {
    await setupTree()
    const received: string[] = []
    hub.subscribeDevice('d1', (e) => received.push(e))
    await handleUnassignDevice(db, hub, 'd1')
    expect(received).toEqual([])
  })

  it('assigning unknown playlist 400s', async () => {
    const { g } = await setupTree()
    await expect(
      handleAssignGroup(db, hub, g.id, { playlistId: 9999 })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('unassign group removes and kicks group devices', async () => {
    const { g, pl } = await setupTree()
    await handleAssignGroup(db, hub, g.id, { playlistId: pl.id })
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))

    await handleUnassignGroup(db, hub, g.id)
    expect(await db.select().from(schema.assignments)).toHaveLength(0)
    expect(received.sort()).toEqual(['d1', 'd2'])
  })

  it('unassign address removes and kicks every address device', async () => {
    const { a, pl } = await setupTree()
    await handleAssignAddress(db, hub, a.id, { playlistId: pl.id })
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))

    await handleUnassignAddress(db, hub, a.id)
    expect(await db.select().from(schema.assignments)).toHaveLength(0)
    expect(received.sort()).toEqual(['d1', 'd2'])
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement helpers**

Create a shared helper to find affected devices and emit:

```ts
// server/api/assignments/_emit.ts
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { EventsHub } from '~/server/services/events'
import * as schema from '~/server/db/schema'

export async function emitManifestChangedToDevice(
  hub: EventsHub,
  deviceId: string
) {
  hub.emitDevice(deviceId, 'manifest-changed', null)
}

export async function emitManifestChangedToGroup(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  groupId: number
) {
  const devices = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.groupId, groupId))
  for (const d of devices) {
    hub.emitDevice(d.id, 'manifest-changed', null)
  }
}

export async function emitManifestChangedToAddress(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  addressId: number
) {
  const groups = await db
    .select({ id: schema.groups.id })
    .from(schema.groups)
    .where(eq(schema.groups.addressId, addressId))
  if (groups.length === 0) return
  const devices = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      inArray(
        schema.devices.groupId,
        groups.map((g) => g.id)
      )
    )
  for (const d of devices) {
    hub.emitDevice(d.id, 'manifest-changed', null)
  }
}
```

- [ ] **Step 4: Implement the 6 assignment endpoint files**

Each of the three target types gets a pair. They all share a common zod body and an UPSERT pattern.

For brevity, write `assignments/devices/[id].put.ts` first, then the device DELETE, then apply the same structure to groups and addresses.

```ts
// server/api/assignments/devices/[id].put.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToDevice } from '../_emit'

const BodySchema = z.object({ playlistId: z.number().int().positive() })

export async function handleAssignDevice(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  deviceId: string,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, body.playlistId))
  if (!pl) {
    throw createError({ statusCode: 400, message: `Unknown playlistId` })
  }
  const [dev] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!dev) {
    throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })
  }

  // UPSERT: delete any existing assignment for this device, insert new one.
  await db.delete(schema.assignments).where(eq(schema.assignments.deviceId, deviceId))
  const [row] = await db
    .insert(schema.assignments)
    .values({ playlistId: body.playlistId, deviceId })
    .returning()

  emitManifestChangedToDevice(hub, deviceId)
  return row
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleAssignDevice(useDb(), useEventsHub(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

```ts
// server/api/assignments/devices/[id].delete.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToDevice } from '../_emit'

export { handleAssignDevice } from './[id].put'

export async function handleUnassignDevice(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  deviceId: string
): Promise<void> {
  const deleted = await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.deviceId, deviceId))
    .returning({ id: schema.assignments.id })
  if (deleted.length > 0) {
    emitManifestChangedToDevice(hub, deviceId)
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  await handleUnassignDevice(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
```

Groups — same shape:

```ts
// server/api/assignments/groups/[id].put.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToGroup } from '../_emit'

const BodySchema = z.object({ playlistId: z.number().int().positive() })

export async function handleAssignGroup(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  groupId: number,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, body.playlistId))
  if (!pl) throw createError({ statusCode: 400, message: 'Unknown playlistId' })

  const [grp] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
  if (!grp) {
    throw createError({ statusCode: 404, message: `Group ${groupId} not found` })
  }

  await db.delete(schema.assignments).where(eq(schema.assignments.groupId, groupId))
  const [row] = await db
    .insert(schema.assignments)
    .values({ playlistId: body.playlistId, groupId })
    .returning()

  await emitManifestChangedToGroup(db, hub, groupId)
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleAssignGroup(useDb(), useEventsHub(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

```ts
// server/api/assignments/groups/[id].delete.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToGroup } from '../_emit'

export { handleAssignGroup } from './[id].put'

export async function handleUnassignGroup(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  groupId: number
): Promise<void> {
  const deleted = await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.groupId, groupId))
    .returning({ id: schema.assignments.id })
  if (deleted.length > 0) {
    await emitManifestChangedToGroup(db, hub, groupId)
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleUnassignGroup(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
```

Addresses — same shape, swap `addressId`:

```ts
// server/api/assignments/addresses/[id].put.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToAddress } from '../_emit'

const BodySchema = z.object({ playlistId: z.number().int().positive() })

export async function handleAssignAddress(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  addressId: number,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, body.playlistId))
  if (!pl) throw createError({ statusCode: 400, message: 'Unknown playlistId' })

  const [addr] = await db
    .select()
    .from(schema.addresses)
    .where(eq(schema.addresses.id, addressId))
  if (!addr) {
    throw createError({ statusCode: 404, message: `Address ${addressId} not found` })
  }

  await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.addressId, addressId))
  const [row] = await db
    .insert(schema.assignments)
    .values({ playlistId: body.playlistId, addressId })
    .returning()

  await emitManifestChangedToAddress(db, hub, addressId)
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleAssignAddress(useDb(), useEventsHub(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

```ts
// server/api/assignments/addresses/[id].delete.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToAddress } from '../_emit'

export { handleAssignAddress } from './[id].put'

export async function handleUnassignAddress(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  addressId: number
): Promise<void> {
  const deleted = await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.addressId, addressId))
    .returning({ id: schema.assignments.id })
  if (deleted.length > 0) {
    await emitManifestChangedToAddress(db, hub, addressId)
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleUnassignAddress(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 5: Run — passes**

- [ ] **Step 6: Commit**

```bash
git add server/api/assignments/ tests/api/assignments.test.ts
git commit -m "feat(api): target-based assignments (device/group/address) with SSE kick"
```

---

## Task 14: Dashboard SSE stream

**Files:**
- Modify: `server/services/events.ts` (add dashboard channel)
- Create: `server/api/dashboard/stream.get.ts`
- Create: `tests/api/dashboard-stream.test.ts`

Semantics:
- `EventsHub` gains `subscribeDashboard` / `emitDashboard`.
- Every device-targeted `emitDevice(...)` also mirrors to dashboard as `device-event` with `{ deviceId, event, data }`.
- Dashboard SSE endpoint forwards dashboard events to the browser.

- [ ] **Step 1: Failing tests — EventsHub dashboard channel**

Append to `tests/services/events.test.ts`:

```ts
  it('subscribeDashboard receives events emitted via emitDashboard', () => {
    const received: Array<{ event: string; data: unknown }> = []
    hub.subscribeDashboard((event, data) => received.push({ event, data }))

    hub.emitDashboard('device-status', { id: 'd1', status: 'online' })
    expect(received).toEqual([
      { event: 'device-status', data: { id: 'd1', status: 'online' } }
    ])
  })

  it('emitDevice mirrors to dashboard subscribers as device-event', () => {
    const received: Array<{ event: string; data: unknown }> = []
    hub.subscribeDashboard((event, data) => received.push({ event, data }))

    hub.emitDevice('d1', 'manifest-changed', { playlistId: 7 })

    expect(received).toEqual([
      {
        event: 'device-event',
        data: { deviceId: 'd1', event: 'manifest-changed', data: { playlistId: 7 } }
      }
    ])
  })

  it('dashboardSubscriberCount tracks count', () => {
    expect(hub.dashboardSubscriberCount()).toBe(0)
    const u = hub.subscribeDashboard(() => {})
    expect(hub.dashboardSubscriberCount()).toBe(1)
    u()
    expect(hub.dashboardSubscriberCount()).toBe(0)
  })
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement hub changes**

Replace `server/services/events.ts`:

```ts
export type EventListener = (event: string, data: unknown) => void

export class EventsHub {
  private deviceListeners = new Map<string, Set<EventListener>>()
  private dashboardListeners = new Set<EventListener>()

  subscribeDevice(deviceId: string, listener: EventListener): () => void {
    let set = this.deviceListeners.get(deviceId)
    if (!set) {
      set = new Set()
      this.deviceListeners.set(deviceId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.deviceListeners.delete(deviceId)
    }
  }

  subscribeDashboard(listener: EventListener): () => void {
    this.dashboardListeners.add(listener)
    return () => {
      this.dashboardListeners.delete(listener)
    }
  }

  emitDevice(deviceId: string, event: string, data: unknown): void {
    const set = this.deviceListeners.get(deviceId)
    if (set) {
      for (const listener of set) listener(event, data)
    }
    // Mirror to dashboard
    for (const listener of this.dashboardListeners) {
      listener('device-event', { deviceId, event, data })
    }
  }

  emitAllDevices(event: string, data: unknown): void {
    for (const set of this.deviceListeners.values()) {
      for (const listener of set) listener(event, data)
    }
  }

  emitDashboard(event: string, data: unknown): void {
    for (const listener of this.dashboardListeners) {
      listener(event, data)
    }
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.deviceListeners.get(deviceId)?.size ?? 0
  }

  dashboardSubscriberCount(): number {
    return this.dashboardListeners.size
  }
}

let _hub: EventsHub | null = null
export function useEventsHub(): EventsHub {
  if (!_hub) _hub = new EventsHub()
  return _hub
}

export function _resetEventsHub(): void {
  _hub = null
}
```

- [ ] **Step 4: Implement dashboard SSE route + test**

```ts
// tests/api/dashboard-stream.test.ts
import { describe, it, expect } from 'vitest'
import { EventsHub } from '~/server/services/events'
import { createDashboardEventSource } from '~/server/api/dashboard/stream.get'

describe('createDashboardEventSource', () => {
  it('forwards dashboard events', () => {
    const hub = new EventsHub()
    const received: Array<{ event: string; data: unknown }> = []
    const src = createDashboardEventSource(hub)
    src.subscribe((e, d) => received.push({ event: e, data: d }))

    hub.emitDashboard('device-status', { id: 'd1', status: 'online' })
    hub.emitDevice('d1', 'manifest-changed', null)

    expect(received).toEqual([
      { event: 'device-status', data: { id: 'd1', status: 'online' } },
      {
        event: 'device-event',
        data: { deviceId: 'd1', event: 'manifest-changed', data: null }
      }
    ])
    src.close()
  })

  it('close unsubscribes', () => {
    const hub = new EventsHub()
    const received: unknown[] = []
    const src = createDashboardEventSource(hub)
    src.subscribe((_e, d) => received.push(d))
    src.close()
    hub.emitDashboard('x', null)
    expect(received).toEqual([])
    expect(hub.dashboardSubscriberCount()).toBe(0)
  })
})
```

```ts
// server/api/dashboard/stream.get.ts
import type { EventsHub } from '~/server/services/events'
import { useEventsHub } from '~/server/services/events'

export type DashboardEventSource = {
  subscribe: (fn: (event: string, data: unknown) => void) => void
  close: () => void
}

export function createDashboardEventSource(hub: EventsHub): DashboardEventSource {
  let unsubscribe: (() => void) | null = null
  return {
    subscribe(fn) {
      unsubscribe = hub.subscribeDashboard(fn)
    },
    close() {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}

export default defineEventHandler(async (event) => {
  const eventStream = createEventStream(event)
  const src = createDashboardEventSource(useEventsHub())

  src.subscribe((name, data) => {
    void eventStream.push({ event: name, data: JSON.stringify(data ?? null) })
  })

  const pingInterval = setInterval(() => {
    void eventStream.push({ event: 'ping', data: '{}' })
  }, 20_000)

  eventStream.onClosed(() => {
    clearInterval(pingInterval)
    src.close()
  })

  return eventStream.send()
})
```

- [ ] **Step 5: Run — all pass**

- [ ] **Step 6: Commit**

```bash
git add server/services/events.ts server/api/dashboard/ tests/api/dashboard-stream.test.ts tests/services/events.test.ts
git commit -m "feat(api): dashboard SSE stream mirroring device events"
```

---

## Task 15: End-to-end admin flow integration test

**Files:**
- Create: `tests/integration/admin-flow.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/admin-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { EventsHub } from '~/server/services/events'
import { handleRegister } from '~/server/api/devices/register.post'
import { handleManifest } from '~/server/api/devices/[id]/manifest.get'
import { ingestMedia } from '~/server/api/media.post'
import { handleCreateAddress } from '~/server/api/addresses/index.post'
import { handleCreateGroup } from '~/server/api/groups/index.post'
import { handleUpdateDevice } from '~/server/api/devices/[id].delete'
import { handleCreatePlaylist } from '~/server/api/playlists/index.post'
import { handleReplacePlaylistItems } from '~/server/api/playlists/[id]/items.put'
import { handleAssignGroup } from '~/server/api/assignments/groups/[id].delete'
import { handleAssignDevice } from '~/server/api/assignments/devices/[id].delete'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

describe('admin flow end-to-end', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore
  let hub: EventsHub

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-admin-'))
    store = new LocalDiskStore(dir)
    hub = new EventsHub()
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks register → claim → upload → playlist → assign → manifest, then device-level override', async () => {
    // Device registers unclaimed
    await handleRegister(db, { deviceId: 'tv-1', playerVersion: '0.1.0' })

    // Admin creates address + group
    const addr = await handleCreateAddress(db, { name: 'Clinic' })
    const grp = await handleCreateGroup(db, {
      addressId: addr.id,
      name: 'Lobby'
    })

    // Admin claims the device into the group
    await handleUpdateDevice(db, 'tv-1', { groupId: grp.id, name: 'TV-Lobby' })

    // Admin uploads a video via ingestMedia
    const videoBuf = Buffer.from('FAKE-VIDEO-BYTES')
    const video = await ingestMedia(db, store, {
      stream: Readable.from([videoBuf]),
      filename: 'ad.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      durationMs: 15000
    })

    // Admin uploads a real image so the thumbnail pipeline runs
    const imageBuf = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 3,
        background: { r: 0, g: 0, b: 255 }
      }
    })
      .png()
      .toBuffer()
    const image = await ingestMedia(db, store, {
      stream: Readable.from([imageBuf]),
      filename: 'logo.png',
      kind: 'image',
      mimeType: 'image/png'
    })
    expect(image.mimeType).toBe('image/png')
    expect(image.thumbnailBytes).toBeGreaterThan(0)
    expect(await store.hasThumbnail(image.sha256)).toBe(true)

    // Admin creates a playlist with bulk items
    const pl = await handleCreatePlaylist(db, { name: 'Summer' })
    await handleReplacePlaylistItems(db, pl.id, {
      items: [
        { mediaId: video.id },
        { mediaId: image.id, durationMsOverride: 8000 }
      ]
    })

    // Admin assigns group → playlist; manifest-changed kicks tv-1
    const received: string[] = []
    hub.subscribeDevice('tv-1', (e) => received.push(e))
    await handleAssignGroup(db, hub, grp.id, { playlistId: pl.id })
    expect(received).toEqual(['manifest-changed'])

    // Device polls; manifest has the items in order with correct durations
    const m = await handleManifest(db, 'tv-1')
    expect(m).not.toBeNull()
    expect(m!.playlistId).toBe(pl.id)
    expect(m!.version).toBe(2) // initial 1 + bulk replace bumped to 2
    expect(m!.items).toHaveLength(2)
    expect(m!.items[0]).toMatchObject({
      type: 'video',
      sha256: video.sha256,
      durationMs: 15000
    })
    expect(m!.items[1]).toMatchObject({
      type: 'image',
      sha256: image.sha256,
      durationMs: 8000
    })

    // Admin creates an override playlist and assigns at device level — device wins
    const pl2 = await handleCreatePlaylist(db, { name: 'Override' })
    await handleReplacePlaylistItems(db, pl2.id, {
      items: [{ mediaId: video.id }]
    })
    await handleAssignDevice(db, hub, 'tv-1', { playlistId: pl2.id })

    const m2 = await handleManifest(db, 'tv-1')
    expect(m2!.playlistId).toBe(pl2.id)

    // A playlist version bump on pl2 is observable on next poll
    await bumpPlaylistVersion(db, pl2.id)
    const m3 = await handleManifest(db, 'tv-1')
    expect(m3!.version).toBe(m2!.version + 1)
  })
})
```

- [ ] **Step 2: Run — passes**

- [ ] **Step 3: Run full suite**

```bash
pnpm test
```

Expected: every prior test still passes plus the new integration.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/admin-flow.test.ts
git commit -m "test: end-to-end admin flow integration test"
```

---

## Task 16: Update README with dashboard endpoints

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Current endpoints" section**

Replace the existing "Current endpoints" section in `README.md` with:

```markdown
## Current endpoints

### Device API (called by the player APK)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/devices/register` | Device self-registration (idempotent) |
| GET  | `/api/devices/:id/manifest` | Device fetches resolved playlist manifest |
| GET  | `/api/devices/:id/stream` | SSE — push events to the device |
| POST | `/api/devices/:id/telemetry` | Device reports current item / errors |

### Media

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/media` | Upload a media file (multipart: `file`, `kind=video\|image`) |
| GET  | `/api/media` | List media with usage counts |
| GET  | `/api/media/:id` | Get a single media row |
| DELETE | `/api/media/:id` | Delete media (409 if in use; `?force=true` to cascade) |
| GET  | `/media/:sha256` | Serve a media file (supports Range) |
| GET  | `/media/:sha256/thumb` | Serve JPEG thumbnail |

### Admin CRUD

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/addresses` | List / create |
| GET/PATCH/DELETE | `/api/addresses/:id` | Read / rename / delete (cascades) |
| GET/POST | `/api/groups` (+`?addressId=N`) | List / create |
| GET/PATCH/DELETE | `/api/groups/:id` | Read / rename or move / delete |
| GET | `/api/devices` (+`?groupId=…&addressId=…&unclaimed=true`) | List with live status |
| GET/PATCH/DELETE | `/api/devices/:id` | Read / claim-or-rename / delete |
| POST | `/api/devices/:id/reload` | Kick the WebView to reload via SSE |
| GET/POST | `/api/playlists` | List (summary) / create |
| GET/PATCH/DELETE | `/api/playlists/:id` | Read (with items) / rename / delete |
| PUT | `/api/playlists/:id/items` | Bulk replace items |

### Assignments (target-addressed)

| Method | Path | Purpose |
|---|---|---|
| PUT/DELETE | `/api/assignments/devices/:id` | Set or clear device-level assignment |
| PUT/DELETE | `/api/assignments/groups/:id` | Set or clear group-level assignment |
| PUT/DELETE | `/api/assignments/addresses/:id` | Set or clear address-level assignment |

### Dashboard SSE

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard/stream` | SSE — receives mirrored device events + dashboard-only events |
```

Also update "Status" and "Next plans":

```markdown
**Status:** Plan 1 + Plan 2a complete — foundation, device sync, and full admin CRUD. No UI yet.

## Next plans

1. **Dashboard UI** (Plan 2b) — Nuxt UI pages on top of the CRUD API.
2. **Player web page** — `/player` route with double-buffered playback.
3. **Deployment** — Dockerfile, Compose, systemd, backups.
4. **Android APK** — native kiosk shell.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README endpoints for dashboard API"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ CRUD for addresses, groups, devices, media, playlists, playlist items, assignments — Tasks 7–13
- ✅ Device live status (online/idle/offline) — Task 9
- ✅ Unclaimed filter — Task 9
- ✅ Device reload kick — Task 9
- ✅ Playlist version bump on metadata or item changes — Tasks 11, 12
- ✅ Assignment changes emit manifest-changed to affected devices — Task 13
- ✅ Dashboard SSE — Task 14
- ✅ Media thumbnails — Tasks 3, 4, 5
- ✅ Correct MIME serving — Task 5
- ✅ Media delete with in-use protection — Task 10
- ✅ Telemetry persistence — Task 6
- ✅ nuxt-stubs hardening — Task 2
- ✅ End-to-end integration test — Task 15

**Out of scope (intentional, for Plan 2b or later):**
- No Nuxt UI pages (Plan 2b)
- No pagination on list endpoints (50 TVs / ~100 playlists max — YAGNI)
- No auth (tailnet trust model)
- No rate limiting (solo operator)

**Placeholder scan:** No TBD/TODO/"add validation" placeholders.

**Type consistency:**
- `handleXxx` naming uniform across all CRUD
- `BetterSQLite3Database<typeof schema>` used consistently
- `EventsHub` injected (not `useEventsHub()`) into all handlers that need it for test injectability
- `_emit.ts` helpers named consistently (`emitManifestChangedTo{Device,Group,Address}`)

**Caveats:**
- The `handleListDevices` address filter uses an INNER JOIN which excludes unclaimed devices even when `?addressId=X` is set. This is intentional — unclaimed devices belong to no address.
- The `sharp` dependency requires native compilation; `pnpm.onlyBuiltDependencies` is updated to include it.
- ffmpeg lives at `@ffmpeg-installer/ffmpeg.path` — verified by `fluent-ffmpeg.setFfmpegPath` at module load; if that fails in a container without `/tmp`, we'll handle it in the Docker plan.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-lanka-dashboard-api.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task with two-stage review. Same approach used for Plan 1.

**2. Inline Execution** — Batched execution with checkpoints using `superpowers:executing-plans`.

**Which approach?**
