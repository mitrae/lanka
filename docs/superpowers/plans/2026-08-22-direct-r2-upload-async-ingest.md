# Direct-to-R2 Upload + Async Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard upload media of any size (≤ 2 GiB) by PUTting the bytes straight to R2 via a presigned URL and transcoding them in a background job, so neither Cloudflare's 100 MB body cap nor any HTTP timeout is in the path.

**Architecture:** A new `media_uploads` job table + a `MediaStore` "staging" extension (presigned PUT to `uploads/<uuid>` on R2, or a same-origin `PUT /file` on local disk). `POST /api/media/uploads` issues a ticket, the browser uploads with XHR progress, `POST …/complete` verifies the staged object and enqueues it; a single in-process worker runs the existing `ingestMedia()` on the staged stream and deletes the staged object. The dashboard polls job status and shows placeholder cards.

**Tech Stack:** Nuxt 4 (SPA) · Nitro · Drizzle + better-sqlite3 · `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (lazy-loaded) · Pinia · Nuxt UI v3 · Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-direct-r2-upload-async-ingest-design.md`

## Global Constraints

- Upload cap default **2 GiB** (`MAX_UPLOAD_BYTES` → `runtimeConfig.maxUploadBytes`; entrypoint bridges to `NUXT_MAX_UPLOAD_BYTES`).
- Presigned URL: **PUT only, 1 h expiry (`expiresIn: 3600`), key `uploads/<uuid-v4>`, `ContentType` signed, `ContentLength` NOT signed.**
- Worker **concurrency 1**; boot recovery `attempts < 2`; pending jobs expire after **24 h**; `TRANSCODE_TIMEOUT_MS` becomes **30 min**.
- Client polls `GET /api/media/uploads/:id` every **3 s** while any job is active; no SSE.
- The R2 PUT must target the S3 endpoint (presigned URL), never `media.lanka.live`.
- All new `/api/media/uploads*` routes are admin/super only (already enforced by `decideAccess`); handlers are exported as `handleXxx(db, store, …)` and tests call those directly (never the default export).
- `tests/helpers/nuxt-stubs.ts` already stubs every Nitro auto-import used here (`readBody`, `getRouterParam`, `getQuery`, `getRequestHeader`, `setResponseStatus`, `useRuntimeConfig`, `createError`); `defineNitroPlugin` is not stubbed and the plugin file must never be imported from tests.
- Run tests with `pnpm test` (or `pnpm vitest run <file>`); `pnpm typecheck` is NOT a gate (hundreds of pre-existing errors) — `pnpm build` is.
- Commit after every task. Don't touch the user's uncommitted `CLAUDE.md` hunk except in Task 12 where CLAUDE.md is deliberately edited (stage only your hunk with `git add -p` or accept that the pre-existing hunk rides along — ask if unsure).

## File map

| File | Responsibility |
|---|---|
| `server/db/schema.ts` | + `mediaUploads` table, `UPLOAD_STATUSES`, relation |
| `server/db/migrations/0012_*.sql` | generated |
| `server/services/media-ingest.ts` | `ingestMedia` (moved verbatim from `media.post.ts`) |
| `server/api/media.post.ts` | legacy sync multipart endpoint, now importing the service |
| `server/services/media-store.ts` | `MediaStore` + staging methods; `LocalDiskStore` impl |
| `server/services/r2-store.ts` | `R2Store` staging impl + presign |
| `server/services/media-uploads.ts` | shared job helpers (`toUploadJob`, parsers, `isUuid`, constants) |
| `server/services/media-ingest-queue.ts` | `createIngestQueue` (FIFO worker, recover, sweep) |
| `server/services/ingest-queue-singleton.ts` | `useIngestQueue()` / `_setIngestQueue()` |
| `server/plugins/ingest-worker.ts` | boot: sweep + recover, hourly sweep |
| `server/api/media/uploads/index.post.ts` | `handleCreateUpload` |
| `server/api/media/uploads/index.get.ts` | `handleListUploads` |
| `server/api/media/uploads/[id].get.ts` | `handleGetUpload` |
| `server/api/media/uploads/[id].delete.ts` | `handleCancelUpload` |
| `server/api/media/uploads/[id]/complete.post.ts` | `handleCompleteUpload` |
| `server/api/media/uploads/[id]/file.put.ts` | `handleReceiveUploadFile` (local-disk transport) |
| `app/types/api.ts` | `UploadJob`, `UploadTicket`, `CreateUploadBody`, `CreatedUpload`, `UploadStatus` |
| `app/composables/useApiClient.ts` | 5 new methods; `uploadMedia` removed |
| `app/composables/useUploader.ts` | `uploadFile()` over XHR with progress/abort |
| `app/stores/media.ts` | `startUpload`, `pollUploads`, placeholders state |
| `app/components/MediaUploadDialog.vue` | sequential uploads with progress + cancel |
| `app/components/MediaProcessingCard.vue` | placeholder card |
| `app/pages/media.vue` | render placeholders, start polling, toast failures |
| `i18n/locales/{en,uk}.json` | new strings |
| `nuxt.config.ts`, `scripts/entrypoint.sh`, `.env.example` | `maxUploadBytes` |
| `scripts/r2-cors.mjs` | one-off bucket CORS rule |
| `README.md`, `CLAUDE.md` | docs |

---

### Task 1: `media_uploads` table + migration

**Files:**
- Modify: `server/db/schema.ts` (after the `media` table, ~line 96; relations at the end)
- Create: `server/db/migrations/0012_*.sql` (generated)
- Test: `tests/db/media-uploads-schema.test.ts`

**Interfaces:**
- Produces: `schema.mediaUploads` (columns `id, filename, kind, quality, mimeType, bytes, status, error, mediaId, attempts, createdAt, updatedAt`), `schema.UPLOAD_STATUSES`, `schema.UploadStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/media-uploads-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import * as schema from '~/server/db/schema'

describe('media_uploads schema', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('inserts a job with defaults (pending, attempts 0, timestamps)', async () => {
    const [row] = await db
      .insert(schema.mediaUploads)
      .values({
        id: '11111111-1111-4111-8111-111111111111',
        filename: 'clip.mp4',
        kind: 'video',
        quality: 'standard',
        mimeType: 'video/mp4',
        bytes: 1234
      })
      .returning()
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.error).toBeNull()
    expect(row.mediaId).toBeNull()
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.updatedAt).toBeInstanceOf(Date)
  })

  it('nulls media_id when the linked media row is deleted', async () => {
    const [m] = await db
      .insert(schema.media)
      .values({ sha256: 'a'.repeat(64), kind: 'image', filename: 'x.png', bytes: 1 })
      .returning()
    await db.insert(schema.mediaUploads).values({
      id: '22222222-2222-4222-8222-222222222222',
      filename: 'x.png',
      kind: 'image',
      quality: 'standard',
      mimeType: 'image/png',
      bytes: 1,
      status: 'done',
      mediaId: m.id
    })
    await db.delete(schema.media).where(eq(schema.media.id, m.id))
    const job = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.id, '22222222-2222-4222-8222-222222222222'))
      .get()
    expect(job?.mediaId).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/db/media-uploads-schema.test.ts`
Expected: FAIL — `schema.mediaUploads` is undefined / `no such table: media_uploads`.

- [ ] **Step 3: Add the table to the schema**

In `server/db/schema.ts`, directly after the `media` table definition (before `export const playlists`):

```ts
export const UPLOAD_STATUSES = [
  'pending',
  'queued',
  'processing',
  'done',
  'failed',
  'expired'
] as const
export type UploadStatus = (typeof UPLOAD_STATUSES)[number]

// Async upload jobs: one row per dashboard upload. The bytes are staged by the
// client straight into the media store (presigned PUT on R2, PUT /file on local
// disk) and ingested by the in-process worker (services/media-ingest-queue).
export const mediaUploads = sqliteTable(
  'media_uploads',
  {
    id: text('id').primaryKey(), // UUID v4
    filename: text('filename').notNull(),
    kind: text('kind', { enum: ['video', 'image'] }).notNull(),
    quality: text('quality', { enum: ['low', 'standard', 'high'] })
      .notNull()
      .default('standard'),
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes').notNull(), // declared by the client at create time
    status: text('status', { enum: UPLOAD_STATUSES }).notNull().default('pending'),
    error: text('error'),
    mediaId: integer('media_id').references(() => media.id, { onDelete: 'set null' }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    statusIdx: index('media_uploads_status_idx').on(t.status),
    createdIdx: index('media_uploads_created_idx').on(t.createdAt)
  })
)
```

And at the end of the file, after `mediaRelations`:

```ts
export const mediaUploadsRelations = relations(mediaUploads, ({ one }) => ({
  media: one(media, { fields: [mediaUploads.mediaId], references: [media.id] })
}))
```

- [ ] **Step 4: Generate the migration and inspect it**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/0012_<name>.sql` plus `meta/0012_snapshot.json` and a `_journal.json` entry. Check: `cat server/db/migrations/0012_*.sql` must contain `CREATE TABLE \`media_uploads\`` with the 12 columns, `FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null`, and the two `CREATE INDEX` statements. Nothing else may change (no ALTERs on other tables).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/db/media-uploads-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the whole suite** (`pnpm test`) — Expected: all green (the migration is applied by `createTestDb`).

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.ts server/db/migrations tests/db/media-uploads-schema.test.ts
git commit -m "feat(media): media_uploads job table (migration 0012)"
```

---

### Task 2: Move `ingestMedia` into a service; raise the transcode timeout

**Files:**
- Create: `server/services/media-ingest.ts`
- Modify: `server/api/media.post.ts` (delete lines 1–162, keep the handler), `server/services/transcode.ts:16`
- Modify tests: `tests/api/media-upload.test.ts:8`, `tests/api/media-upload-transcode.test.ts:9`

**Interfaces:**
- Produces: `ingestMedia(db, store, input: IngestInput): Promise<IngestedMedia>`, `IngestInput { stream: Readable; filename; kind: 'video'|'image'; mimeType?; durationMs?; width?; height?; quality?: QualityPreset }`, `IngestedMedia = typeof schema.media.$inferSelect` — all from `~/server/services/media-ingest`.

- [ ] **Step 1: Create the service by moving the code verbatim**

`server/services/media-ingest.ts` = lines 1–162 of the current `server/api/media.post.ts` **minus** the `formidable` import and the `useDb`/`useMediaStore` imports (they are only used by the handler). Resulting import block:

```ts
import { createHash } from 'node:crypto'
import { mkdtempSync, createReadStream, statSync, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import type { MediaStore } from '~/server/services/media-store'
import { ensureQuality, type QualityPreset } from '~/server/services/transcode'
```

followed by `export type IngestInput`, `export type IngestedMedia`, and `export async function ingestMedia(...)` exactly as they are today (body unchanged, including the `createError` calls — it is a global auto-import).

- [ ] **Step 2: Slim the route file**

`server/api/media.post.ts` becomes:

```ts
import { createReadStream } from 'node:fs'
import formidable from 'formidable'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import { ingestMedia } from '~/server/services/media-ingest'
import type { QualityPreset } from '~/server/services/transcode'

// Legacy synchronous multipart upload. The dashboard no longer uses it (it
// goes through /api/media/uploads — presigned direct-to-store + async ingest);
// kept for curl/scripts. Still subject to Cloudflare's 100 MB body cap and
// the 100 s / 60 s proxy timeouts when reached via app.lanka.live.
export default defineEventHandler(async (event) => {
  // …the existing handler body, unchanged from today's lines 165–202…
})
```

- [ ] **Step 3: Update the two test imports**

In `tests/api/media-upload.test.ts` and `tests/api/media-upload-transcode.test.ts` replace
`import { ingestMedia } from '~/server/api/media.post'` with
`import { ingestMedia } from '~/server/services/media-ingest'`.

- [ ] **Step 4: Raise the transcode timeout**

`server/services/transcode.ts:16` →

```ts
// 30 min: ingest runs in the background worker (services/media-ingest-queue),
// so no HTTP request is held open during transcode; long/`high` clips on the
// 2-vCPU prod box can legitimately take this long.
const TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000
```

- [ ] **Step 5: Run the suite** — `pnpm test` — Expected: all green (`media-upload*.test.ts` unchanged in behaviour; `tests/services/transcode.test.ts` does not assert the timeout value).

- [ ] **Step 6: Commit**

```bash
git add server/services/media-ingest.ts server/api/media.post.ts server/services/transcode.ts tests/api/media-upload.test.ts tests/api/media-upload-transcode.test.ts
git commit -m "refactor(media): move ingestMedia to services/media-ingest; 30 min transcode timeout"
```

---

### Task 3: `MediaStore` staging API — interface + `LocalDiskStore`

**Files:**
- Modify: `server/services/media-store.ts`
- Test: `tests/services/media-store.test.ts` (append a `describe`)

**Interfaces:**
- Produces (on `MediaStore`):
  ```ts
  export interface StagedUploadTicket {
    method: 'PUT'
    url: string
    headers: Record<string, string>
    expiresAt: number // epoch ms
  }
  export const STAGED_UPLOAD_TTL_MS = 60 * 60 * 1000
  createStagedUpload(id: string, opts: { contentType: string; bytes: number }): Promise<StagedUploadTicket>
  putStaged(id: string, stream: Readable, contentType: string): Promise<void>
  statStaged(id: string): Promise<{ bytes: number } | null>
  openStaged(id: string): Promise<Readable>
  deleteStaged(id: string): Promise<void> // idempotent
  ```
  Local ticket URL is `/api/media/uploads/<id>/file`; local files live at `<dir>/.uploads/<id>`.

- [ ] **Step 1: Write the failing tests** (append to `tests/services/media-store.test.ts`, inside a new top-level `describe`; reuse the same imports plus `import { STAGED_UPLOAD_TTL_MS } from '~/server/services/media-store'`)

```ts
describe('LocalDiskStore staging', () => {
  let dir: string
  let store: LocalDiskStore
  const id = '33333333-3333-4333-8333-333333333333'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lanka-test-'))
    store = new LocalDiskStore(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('createStagedUpload returns a same-origin PUT ticket bound to the content type', async () => {
    const before = Date.now()
    const t = await store.createStagedUpload(id, { contentType: 'video/mp4', bytes: 10 })
    expect(t.method).toBe('PUT')
    expect(t.url).toBe(`/api/media/uploads/${id}/file`)
    expect(t.headers).toEqual({ 'content-type': 'video/mp4' })
    expect(t.expiresAt).toBeGreaterThanOrEqual(before + STAGED_UPLOAD_TTL_MS - 5)
  })

  it('putStaged / statStaged / openStaged round-trip under .uploads/', async () => {
    await store.putStaged(id, Readable.from([Buffer.from('staged!')]), 'video/mp4')
    expect(existsSync(join(dir, '.uploads', id))).toBe(true)
    expect(await store.statStaged(id)).toEqual({ bytes: 7 })
    const chunks: Buffer[] = []
    for await (const c of await store.openStaged(id)) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('staged!')
  })

  it('statStaged is null when absent; deleteStaged is idempotent', async () => {
    expect(await store.statStaged(id)).toBeNull()
    await expect(store.deleteStaged(id)).resolves.toBeUndefined()
    await store.putStaged(id, Readable.from([Buffer.from('x')]), 'image/png')
    await store.deleteStaged(id)
    expect(await store.statStaged(id)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/services/media-store.test.ts` — Expected: FAIL (`store.createStagedUpload is not a function`).

- [ ] **Step 3: Implement**

In `server/services/media-store.ts`, above the interface:

```ts
/** Where a client must send the raw bytes of a staged upload (see
 *  /api/media/uploads). On R2 this is a presigned PUT to the S3 endpoint; on
 *  local disk it is the app's own PUT /api/media/uploads/:id/file route. */
export interface StagedUploadTicket {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: number // epoch ms
}

export const STAGED_UPLOAD_TTL_MS = 60 * 60 * 1000 // 1 h
```

Add to `interface MediaStore` (after `deleteThumbnail`):

```ts
  // --- staged uploads (bytes land here first; the ingest worker moves them) ---
  createStagedUpload(
    id: string,
    opts: { contentType: string; bytes: number }
  ): Promise<StagedUploadTicket>
  putStaged(id: string, stream: Readable, contentType: string): Promise<void>
  /** null when no staged object exists for `id`. */
  statStaged(id: string): Promise<{ bytes: number } | null>
  openStaged(id: string): Promise<Readable>
  /** Idempotent. */
  deleteStaged(id: string): Promise<void>
```

Add to `class LocalDiskStore`:

```ts
  private stagedPath(id: string): string {
    return join(this.dir, '.uploads', id)
  }

  async createStagedUpload(
    id: string,
    opts: { contentType: string; bytes: number }
  ): Promise<StagedUploadTicket> {
    return {
      method: 'PUT',
      url: `/api/media/uploads/${id}/file`,
      headers: { 'content-type': opts.contentType },
      expiresAt: Date.now() + STAGED_UPLOAD_TTL_MS
    }
  }

  async putStaged(id: string, stream: Readable, _contentType: string): Promise<void> {
    await this.putAtomic(this.stagedPath(id), stream)
  }

  async statStaged(id: string): Promise<{ bytes: number } | null> {
    try {
      const s = await fsStat(this.stagedPath(id))
      return { bytes: s.size }
    } catch (err: any) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async openStaged(id: string): Promise<Readable> {
    return createReadStream(this.stagedPath(id))
  }

  async deleteStaged(id: string): Promise<void> {
    try {
      await unlink(this.stagedPath(id))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }
```

- [ ] **Step 4: Run** — `pnpm vitest run tests/services/media-store.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/media-store.ts tests/services/media-store.test.ts
git commit -m "feat(media-store): staged-upload API (LocalDiskStore)"
```

---

### Task 4: `R2Store` staging + presigned PUT

**Files:**
- Modify: `package.json` (new runtime dep), `server/services/r2-store.ts`
- Test: `tests/services/r2-store.test.ts`

**Interfaces:**
- Consumes: `StagedUploadTicket`, `STAGED_UPLOAD_TTL_MS` (Task 3).
- Produces: `R2Store` implementing the five staging methods; key `uploads/<id>`.

- [ ] **Step 1: Add the presigner dependency**

Run: `pnpm add @aws-sdk/s3-request-presigner@^3.1063.0`
Expected: `package.json` gains `"@aws-sdk/s3-request-presigner": "^3.1063.0"` next to `@aws-sdk/client-s3`; lockfile updated.

- [ ] **Step 2: Write the failing tests** (in `tests/services/r2-store.test.ts`)

Extend the hoisted mocks and the `@aws-sdk/client-s3` mock:

```ts
const { sendMock, uploadCtor, uploadDone, getSignedUrlMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  uploadCtor: vi.fn(),
  uploadDone: vi.fn().mockResolvedValue(undefined),
  getSignedUrlMock: vi.fn().mockResolvedValue('https://acct.r2.cloudflarestorage.com/signed')
}))
// in the client-s3 mock's returned object add:
//     PutObjectCommand: class extends Cmd {},
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: getSignedUrlMock }))
```

Add `getSignedUrlMock.mockClear()` to `beforeEach`, then append tests:

```ts
  it('createStagedUpload presigns a 1h PUT for uploads/<id> bound to the content type', async () => {
    const store = new R2Store(cfg)
    const id = '44444444-4444-4444-8444-444444444444'
    const t = await store.createStagedUpload(id, { contentType: 'video/mp4', bytes: 5 })
    expect(t.method).toBe('PUT')
    expect(t.url).toBe('https://acct.r2.cloudflarestorage.com/signed')
    expect(t.headers).toEqual({ 'content-type': 'video/mp4' })
    const [, cmd, opts] = getSignedUrlMock.mock.calls[0]
    expect(cmd.input).toEqual({ Bucket: 'lanka-media', Key: `uploads/${id}`, ContentType: 'video/mp4' })
    expect(opts).toEqual({ expiresIn: 3600 })
  })

  it('statStaged returns the size or null on 404; openStaged/deleteStaged use uploads/<id>', async () => {
    const store = new R2Store(cfg)
    const id = '55555555-5555-4555-8555-555555555555'
    sendMock.mockResolvedValueOnce({ ContentLength: 42 })
    expect(await store.statStaged(id)).toEqual({ bytes: 42 })
    expect(lastInput().Key).toBe(`uploads/${id}`)
    sendMock.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
    expect(await store.statStaged(id)).toBeNull()
    const body = Readable.from([Buffer.from('z')])
    sendMock.mockResolvedValueOnce({ Body: body })
    expect(await store.openStaged(id)).toBe(body)
    sendMock.mockResolvedValueOnce({})
    await store.deleteStaged(id)
    expect(lastInput().Key).toBe(`uploads/${id}`)
  })

  it('putStaged streams to uploads/<id> with the content type', async () => {
    const store = new R2Store(cfg)
    await store.putStaged('66666666-6666-4666-8666-666666666666', Readable.from([Buffer.from('q')]), 'image/png')
    expect(uploadCtor.mock.calls[0][0].params).toMatchObject({
      Bucket: 'lanka-media',
      Key: 'uploads/66666666-6666-4666-8666-666666666666',
      ContentType: 'image/png'
    })
  })
```

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run tests/services/r2-store.test.ts` — Expected: FAIL on the three new tests.

- [ ] **Step 4: Implement** (in `server/services/r2-store.ts`)

Imports: `import { STAGED_UPLOAD_TTL_MS, type MediaStore, type StagedUploadTicket } from './media-store'`. Add to the class:

```ts
  private stagedKey(id: string): string {
    return `uploads/${id}`
  }

  // --- staged uploads ---

  async createStagedUpload(
    id: string,
    opts: { contentType: string; bytes: number }
  ): Promise<StagedUploadTicket> {
    const { PutObjectCommand } = await this.mod()
    // Lazy like the rest of the SDK: only loaded when R2 is configured.
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    // ContentType is part of the signature so the client must send exactly it;
    // ContentLength is deliberately NOT signed (browsers set it themselves) —
    // the size is verified server-side on /complete via statStaged().
    const url: string = await getSignedUrl(
      await this.s3(),
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.stagedKey(id),
        ContentType: opts.contentType
      }),
      { expiresIn: STAGED_UPLOAD_TTL_MS / 1000 }
    )
    return {
      method: 'PUT',
      url,
      headers: { 'content-type': opts.contentType },
      expiresAt: Date.now() + STAGED_UPLOAD_TTL_MS
    }
  }

  async putStaged(id: string, stream: Readable, contentType: string): Promise<void> {
    await this.upload(this.stagedKey(id), stream, contentType)
  }

  async statStaged(id: string): Promise<{ bytes: number } | null> {
    const { HeadObjectCommand } = await this.mod()
    try {
      const s3 = await this.s3()
      const res = await s3.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.stagedKey(id) })
      )
      return { bytes: res.ContentLength ?? 0 }
    } catch (err: any) {
      if (
        err?.$metadata?.httpStatusCode === 404 ||
        err?.name === 'NotFound' ||
        err?.name === 'NoSuchKey'
      ) {
        return null
      }
      throw err
    }
  }

  async openStaged(id: string): Promise<Readable> {
    return this.get(this.stagedKey(id))
  }

  async deleteStaged(id: string): Promise<void> {
    await this.del(this.stagedKey(id))
  }
```

- [ ] **Step 5: Run** — `pnpm vitest run tests/services/r2-store.test.ts` — Expected: PASS. Then `pnpm test` — all green.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml server/services/r2-store.ts tests/services/r2-store.test.ts
git commit -m "feat(r2-store): presigned staged uploads (uploads/<id>)"
```

---

### Task 5: Ingest queue worker + singleton + Nitro plugin

**Files:**
- Create: `server/services/media-ingest-queue.ts`, `server/services/ingest-queue-singleton.ts`, `server/plugins/ingest-worker.ts`
- Test: `tests/services/media-ingest-queue.test.ts`

**Interfaces:**
- Consumes: `ingestMedia`/`IngestInput`/`IngestedMedia` (Task 2), `MediaStore.openStaged/deleteStaged` (Task 3), `schema.mediaUploads` (Task 1).
- Produces:
  ```ts
  export const PENDING_TTL_MS = 24 * 60 * 60 * 1000
  export const MAX_ATTEMPTS = 2
  export type IngestFn = (db: Db, store: MediaStore, input: IngestInput) => Promise<IngestedMedia>
  export interface IngestQueue {
    enqueue(id: string): void
    idle(): Promise<void>            // resolves once nothing is running/queued
    recover(): Promise<void>
    sweep(now?: number): Promise<number> // returns #expired
  }
  export function createIngestQueue(deps: { db: Db; store: MediaStore; ingest?: IngestFn; log?: (msg: string, meta?: unknown) => void }): IngestQueue
  // singleton
  export function useIngestQueue(): IngestQueue
  export function _setIngestQueue(q: IngestQueue | null): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/services/media-ingest-queue.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import {
  createIngestQueue,
  PENDING_TTL_MS,
  type IngestFn
} from '~/server/services/media-ingest-queue'
import * as schema from '~/server/db/schema'

const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('createIngestQueue', () => {
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

  async function insertJob(
    id: string,
    over: Partial<typeof schema.mediaUploads.$inferInsert> = {}
  ) {
    const [row] = await db
      .insert(schema.mediaUploads)
      .values({
        id,
        filename: 'clip.mp4',
        kind: 'video',
        quality: 'standard',
        mimeType: 'video/mp4',
        bytes: 3,
        status: 'queued',
        ...over
      })
      .returning()
    return row
  }

  async function stage(id: string, text = 'abc') {
    await store.putStaged(id, Readable.from([Buffer.from(text)]), 'video/mp4')
  }

  async function job(id: string) {
    return (await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, id)).get())!
  }

  async function insertMedia(sha = 'c'.repeat(64)) {
    const [m] = await db
      .insert(schema.media)
      .values({ sha256: sha, kind: 'video', filename: 'clip.mp4', bytes: 3 })
      .returning()
    return m
  }

  it('processes a queued job: ingests the staged stream, marks done, deletes the staged object', async () => {
    await insertJob(ID1)
    await stage(ID1)
    const media = await insertMedia()
    const ingest: IngestFn = vi.fn(async (_db, _store, input) => {
      const chunks: Buffer[] = []
      for await (const c of input.stream) chunks.push(c as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('abc')
      expect(input).toMatchObject({ filename: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', quality: 'standard' })
      return media
    })
    const q = createIngestQueue({ db, store, ingest, log: () => {} })
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('done')
    expect(row.mediaId).toBe(media.id)
    expect(row.attempts).toBe(1)
    expect(row.error).toBeNull()
    expect(await store.statStaged(ID1)).toBeNull()
  })

  it('marks failed with the error message and still deletes the staged object', async () => {
    await insertJob(ID1)
    await stage(ID1)
    const ingest: IngestFn = vi.fn().mockRejectedValue(new Error('Could not process this video'))
    const q = createIngestQueue({ db, store, ingest, log: () => {} })
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('Could not process this video')
    expect(await store.statStaged(ID1)).toBeNull()
  })

  it('runs one job at a time, FIFO', async () => {
    await insertJob(ID1)
    await insertJob(ID2)
    await stage(ID1)
    await stage(ID2)
    const media = await insertMedia()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ingest: IngestFn = vi.fn(async (_db, _store, input) => {
      order.push(`start:${input.filename}`)
      if (order.length === 1) await gate
      order.push(`end:${input.filename}`)
      return media
    })
    await db.update(schema.mediaUploads).set({ filename: 'one' }).where(eq(schema.mediaUploads.id, ID1))
    await db.update(schema.mediaUploads).set({ filename: 'two' }).where(eq(schema.mediaUploads.id, ID2))
    const q = createIngestQueue({ db, store, ingest, log: () => {} })
    q.enqueue(ID1)
    q.enqueue(ID2)
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['start:one']) // second has not started
    release()
    await q.idle()
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
  })

  it('skips ids that are no longer queued (cancelled meanwhile)', async () => {
    await insertJob(ID1, { status: 'pending' })
    const ingest = vi.fn()
    const q = createIngestQueue({ db, store, ingest: ingest as IngestFn, log: () => {} })
    q.enqueue(ID1)
    q.enqueue('not-a-row')
    await q.idle()
    expect(ingest).not.toHaveBeenCalled()
    expect((await job(ID1)).status).toBe('pending')
  })

  it('recover() re-queues interrupted jobs once, fails them on the second interruption, and enqueues queued rows', async () => {
    await insertJob(ID1, { status: 'processing', attempts: 1 })
    await insertJob(ID2, { status: 'processing', attempts: 2 })
    await insertJob('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { status: 'queued' })
    await stage(ID1)
    await stage('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const media = await insertMedia()
    const ingest: IngestFn = vi.fn().mockResolvedValue(media)
    const q = createIngestQueue({ db, store, ingest, log: () => {} })
    await q.recover()
    await q.idle()
    expect((await job(ID1)).status).toBe('done')
    expect((await job(ID1)).attempts).toBe(2)
    expect((await job(ID2)).status).toBe('failed')
    expect((await job(ID2)).error).toMatch(/interrupted/i)
    expect((await job('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).status).toBe('done')
    expect(ingest).toHaveBeenCalledTimes(2)
  })

  it('sweep() expires pending jobs older than 24h and deletes their staged objects', async () => {
    const now = Date.now()
    await insertJob(ID1, { status: 'pending', createdAt: new Date(now - PENDING_TTL_MS - 1000) })
    await insertJob(ID2, { status: 'pending', createdAt: new Date(now - 1000) })
    await stage(ID1)
    const q = createIngestQueue({ db, store, ingest: vi.fn() as IngestFn, log: () => {} })
    expect(await q.sweep(now)).toBe(1)
    expect((await job(ID1)).status).toBe('expired')
    expect(await store.statStaged(ID1)).toBeNull()
    expect((await job(ID2)).status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/services/media-ingest-queue.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement the queue**

```ts
// server/services/media-ingest-queue.ts
//
// Single in-process worker that turns staged uploads (media_uploads rows whose
// bytes already sit in the media store under uploads/<id>) into media rows by
// running the same ingestMedia() the synchronous endpoint uses. Concurrency is
// 1 on purpose: ffmpeg already saturates the 2-vCPU prod box. One Nitro
// process owns the queue — there is no cross-process locking.
import { and, asc, eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import type { MediaStore } from './media-store'
import { ingestMedia, type IngestInput, type IngestedMedia } from './media-ingest'

type Db = BetterSQLite3Database<typeof schema>

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_ATTEMPTS = 2

export type IngestFn = (db: Db, store: MediaStore, input: IngestInput) => Promise<IngestedMedia>

export interface IngestQueue {
  enqueue(id: string): void
  /** Resolves once the worker has nothing queued or running. */
  idle(): Promise<void>
  /** Boot: re-queue jobs interrupted mid-processing (once), enqueue all queued rows. */
  recover(): Promise<void>
  /** Expire `pending` jobs older than PENDING_TTL_MS; returns how many. */
  sweep(now?: number): Promise<number>
}

export function createIngestQueue(deps: {
  db: Db
  store: MediaStore
  ingest?: IngestFn
  log?: (msg: string, meta?: unknown) => void
}): IngestQueue {
  const { db, store } = deps
  const ingest = deps.ingest ?? ingestMedia
  const log = deps.log ?? ((msg, meta) => console.warn(msg, meta ?? ''))
  const fifo: string[] = []
  let running: Promise<void> | null = null
  let idleWaiters: (() => void)[] = []

  async function processOne(id: string): Promise<void> {
    const row = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.id, id))
      .get()
    // Cancelled/expired (or never existed) while waiting in the FIFO.
    if (!row || row.status !== 'queued') return

    await db
      .update(schema.mediaUploads)
      .set({ status: 'processing', attempts: row.attempts + 1, updatedAt: new Date() })
      .where(eq(schema.mediaUploads.id, id))
    try {
      const stream = await store.openStaged(id)
      const media = await ingest(db, store, {
        stream,
        filename: row.filename,
        kind: row.kind,
        mimeType: row.mimeType,
        quality: row.quality
      })
      await db
        .update(schema.mediaUploads)
        .set({ status: 'done', mediaId: media.id, error: null, updatedAt: new Date() })
        .where(eq(schema.mediaUploads.id, id))
    } catch (err) {
      await db
        .update(schema.mediaUploads)
        .set({
          status: 'failed',
          error: (err as Error).message || 'Ingest failed',
          updatedAt: new Date()
        })
        .where(eq(schema.mediaUploads.id, id))
    } finally {
      try {
        await store.deleteStaged(id)
      } catch (err) {
        log('[ingest-queue] could not delete staged object', { id, err: (err as Error).message })
      }
    }
  }

  async function loop(): Promise<void> {
    while (fifo.length > 0) {
      const id = fifo.shift()!
      try {
        await processOne(id)
      } catch (err) {
        log('[ingest-queue] unexpected error', { id, err: (err as Error).message })
      }
    }
    running = null
    const waiters = idleWaiters
    idleWaiters = []
    for (const w of waiters) w()
  }

  function enqueue(id: string): void {
    fifo.push(id)
    if (!running) running = loop()
  }

  function idle(): Promise<void> {
    if (!running) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  async function recover(): Promise<void> {
    const stuck = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.status, 'processing'))
    for (const row of stuck) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await db
          .update(schema.mediaUploads)
          .set({ status: 'failed', error: 'Interrupted during processing', updatedAt: new Date() })
          .where(eq(schema.mediaUploads.id, row.id))
        try {
          await store.deleteStaged(row.id)
        } catch (err) {
          log('[ingest-queue] could not delete staged object', { id: row.id, err: (err as Error).message })
        }
      } else {
        await db
          .update(schema.mediaUploads)
          .set({ status: 'queued', updatedAt: new Date() })
          .where(eq(schema.mediaUploads.id, row.id))
      }
    }
    const queued = await db
      .select({ id: schema.mediaUploads.id })
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.status, 'queued'))
      .orderBy(asc(schema.mediaUploads.createdAt))
    for (const r of queued) enqueue(r.id)
  }

  async function sweep(now: number = Date.now()): Promise<number> {
    const stale = await db
      .select()
      .from(schema.mediaUploads)
      .where(
        and(
          eq(schema.mediaUploads.status, 'pending'),
          lt(schema.mediaUploads.createdAt, new Date(now - PENDING_TTL_MS))
        )
      )
    for (const row of stale) {
      try {
        await store.deleteStaged(row.id)
      } catch (err) {
        log('[ingest-queue] could not delete staged object', { id: row.id, err: (err as Error).message })
      }
      await db
        .update(schema.mediaUploads)
        .set({ status: 'expired', error: 'Upload was never completed', updatedAt: new Date(now) })
        .where(eq(schema.mediaUploads.id, row.id))
    }
    return stale.length
  }

  return { enqueue, idle, recover, sweep }
}
```

- [ ] **Step 4: Run** — `pnpm vitest run tests/services/media-ingest-queue.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Singleton + plugin** (no tests — thin wiring; the plugin must never be imported by tests)

```ts
// server/services/ingest-queue-singleton.ts
import { useDb } from '~/server/db/client'
import { useMediaStore } from './media-store-singleton'
import { createIngestQueue, type IngestQueue } from './media-ingest-queue'

let _queue: IngestQueue | null = null

export function useIngestQueue(): IngestQueue {
  if (!_queue) _queue = createIngestQueue({ db: useDb(), store: useMediaStore() })
  return _queue
}

export function _setIngestQueue(queue: IngestQueue | null): void {
  _queue = queue
}
```

```ts
// server/plugins/ingest-worker.ts
//
// Boots the async media-ingest worker: expire abandoned uploads, re-queue jobs
// interrupted by the last restart, then sweep hourly. Jobs are enqueued live by
// POST /api/media/uploads/:id/complete.
import { useIngestQueue } from '~/server/services/ingest-queue-singleton'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export default defineNitroPlugin(async () => {
  const queue = useIngestQueue()
  try {
    const expired = await queue.sweep()
    if (expired > 0) console.log(`[ingest-queue] expired ${expired} abandoned upload(s)`)
    await queue.recover()
  } catch (err) {
    console.error('[ingest-queue] boot recovery failed', err)
  }
  const timer = setInterval(() => {
    queue.sweep().catch((err) => console.warn('[ingest-queue] sweep failed', err))
  }, SWEEP_INTERVAL_MS)
  timer.unref()
})
```

- [ ] **Step 6: Full suite + build** — `pnpm test` then `pnpm build` — Expected: green; build succeeds (the plugin compiles; no runtime check yet).

- [ ] **Step 7: Commit**

```bash
git add server/services/media-ingest-queue.ts server/services/ingest-queue-singleton.ts server/plugins/ingest-worker.ts tests/services/media-ingest-queue.test.ts
git commit -m "feat(media): in-process ingest queue with boot recovery + pending sweep"
```

---

### Task 6: Upload job API — create / list / get / cancel (+ `maxUploadBytes` config)

**Files:**
- Create: `server/services/media-uploads.ts`, `server/api/media/uploads/index.post.ts`, `server/api/media/uploads/index.get.ts`, `server/api/media/uploads/[id].get.ts`, `server/api/media/uploads/[id].delete.ts`
- Modify: `nuxt.config.ts` (runtimeConfig), `scripts/entrypoint.sh:54`, `.env.example`
- Test: `tests/api/media-uploads.test.ts`

**Interfaces:**
- Consumes: `schema.mediaUploads` (Task 1), `MediaStore.createStagedUpload/deleteStaged` (Task 3).
- Produces:
  ```ts
  // server/services/media-uploads.ts
  export type UploadJobRow = typeof schema.mediaUploads.$inferSelect
  export interface UploadJob extends UploadJobRow { media?: IngestedMedia | null }
  export const ACTIVE_UPLOAD_STATUSES = ['pending', 'queued', 'processing'] as const
  export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3
  export function isUuid(s: unknown): s is string
  export function parseKind(raw: unknown): 'video' | 'image'          // throws 400
  export function parseQuality(raw: unknown): QualityPreset           // throws 400, default 'standard'
  export function toUploadJob(row: UploadJobRow, media?: IngestedMedia | null): UploadJob
  // handlers
  handleCreateUpload(db, store, input: CreateUploadInput, opts: { maxBytes: number }): Promise<UploadJob & { upload: StagedUploadTicket }>
  handleListUploads(db, opts: { active: boolean }): Promise<UploadJob[]>
  handleGetUpload(db, id: string): Promise<UploadJob>
  handleCancelUpload(db, store, id: string): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/api/media-uploads.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleCreateUpload } from '~/server/api/media/uploads/index.post'
import { handleListUploads } from '~/server/api/media/uploads/index.get'
import { handleGetUpload } from '~/server/api/media/uploads/[id].get'
import { handleCancelUpload } from '~/server/api/media/uploads/[id].delete'
import * as schema from '~/server/db/schema'

const MAX = 2 * 1024 ** 3

describe('upload job API', () => {
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

  const valid = { filename: '  clip.mp4 ', kind: 'video', quality: 'high', mimeType: 'video/MP4', bytes: 1000 }

  describe('handleCreateUpload', () => {
    it('creates a pending job and returns a ticket from the store', async () => {
      const res = await handleCreateUpload(db, store, valid, { maxBytes: MAX })
      expect(res.status).toBe('pending')
      expect(res.filename).toBe('clip.mp4')
      expect(res.quality).toBe('high')
      expect(res.mimeType).toBe('video/mp4')
      expect(res.bytes).toBe(1000)
      expect(res.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.upload).toEqual({
        method: 'PUT',
        url: `/api/media/uploads/${res.id}/file`,
        headers: { 'content-type': 'video/mp4' },
        expiresAt: expect.any(Number)
      })
      const row = await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, res.id)).get()
      expect(row?.status).toBe('pending')
    })

    it('defaults quality to standard and allows application/octet-stream', async () => {
      const res = await handleCreateUpload(
        db, store,
        { filename: 'clip.mkv', kind: 'video', mimeType: 'application/octet-stream', bytes: 5 },
        { maxBytes: MAX }
      )
      expect(res.quality).toBe('standard')
      expect(res.mimeType).toBe('application/octet-stream')
    })

    it.each([
      [{ ...valid, kind: 'audio' }, 400, /kind/],
      [{ ...valid, quality: 'ultra' }, 400, /quality/],
      [{ ...valid, filename: '   ' }, 400, /filename/],
      [{ ...valid, mimeType: 'image/png' }, 400, /mimeType/],
      [{ ...valid, bytes: 0 }, 400, /bytes/],
      [{ ...valid, bytes: 1.5 }, 400, /bytes/],
      [{ ...valid, bytes: MAX + 1 }, 413, /limit/]
    ])('rejects %o', async (input, status, re) => {
      await expect(handleCreateUpload(db, store, input as any, { maxBytes: MAX })).rejects.toMatchObject({ statusCode: status })
      await expect(handleCreateUpload(db, store, input as any, { maxBytes: MAX })).rejects.toThrow(re)
    })

    it('caps the filename at 255 chars', async () => {
      const res = await handleCreateUpload(db, store, { ...valid, filename: 'x'.repeat(300) }, { maxBytes: MAX })
      expect(res.filename).toHaveLength(255)
    })
  })

  describe('list / get / cancel', () => {
    async function seed(id: string, status: schema.UploadStatus, createdAt = new Date()) {
      await db.insert(schema.mediaUploads).values({
        id, filename: 'f', kind: 'image', quality: 'standard', mimeType: 'image/png', bytes: 1, status, createdAt
      })
    }
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    it('handleListUploads({active:true}) returns only pending/queued/processing, newest first', async () => {
      await seed(A, 'pending', new Date(1000))
      await seed(B, 'processing', new Date(3000))
      await seed(C, 'done', new Date(2000))
      const active = await handleListUploads(db, { active: true })
      expect(active.map((j) => j.id)).toEqual([B, A])
      const all = await handleListUploads(db, { active: false })
      expect(all.map((j) => j.id)).toEqual([B, C, A])
    })

    it('handleGetUpload embeds the media row when done and 404s otherwise', async () => {
      const [m] = await db.insert(schema.media).values({ sha256: 'd'.repeat(64), kind: 'image', filename: 'f', bytes: 1 }).returning()
      await seed(A, 'done')
      await db.update(schema.mediaUploads).set({ mediaId: m.id }).where(eq(schema.mediaUploads.id, A))
      const job = await handleGetUpload(db, A)
      expect(job.media?.id).toBe(m.id)
      await seed(B, 'queued')
      expect((await handleGetUpload(db, B)).media).toBeNull()
      await expect(handleGetUpload(db, C)).rejects.toMatchObject({ statusCode: 404 })
      await expect(handleGetUpload(db, '../etc/passwd')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('handleCancelUpload deletes a pending job and its staged file; 409 otherwise', async () => {
      await seed(A, 'pending')
      await store.putStaged(A, Readable.from([Buffer.from('x')]), 'image/png')
      await handleCancelUpload(db, store, A)
      expect(await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, A)).get()).toBeUndefined()
      expect(await store.statStaged(A)).toBeNull()
      await seed(B, 'queued')
      await expect(handleCancelUpload(db, store, B)).rejects.toMatchObject({ statusCode: 409 })
      await expect(handleCancelUpload(db, store, C)).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/api/media-uploads.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Shared helpers**

```ts
// server/services/media-uploads.ts
import * as schema from '~/server/db/schema'
import type { IngestedMedia } from './media-ingest'
import type { QualityPreset } from './transcode'

export type UploadJobRow = typeof schema.mediaUploads.$inferSelect
export interface UploadJob extends UploadJobRow {
  media?: IngestedMedia | null
}

export const ACTIVE_UPLOAD_STATUSES = ['pending', 'queued', 'processing'] as const
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3 // 2 GiB

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QUALITIES: readonly QualityPreset[] = ['low', 'standard', 'high']

/** Route params become store keys (`uploads/<id>`): only accept UUID v4. */
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

export function parseKind(raw: unknown): 'video' | 'image' {
  if (raw === 'video' || raw === 'image') return raw
  throw createError({ statusCode: 400, message: 'kind must be "video" or "image"' })
}

export function parseQuality(raw: unknown): QualityPreset {
  if (raw === undefined || raw === null || raw === '') return 'standard'
  if (typeof raw === 'string' && (QUALITIES as readonly string[]).includes(raw)) {
    return raw as QualityPreset
  }
  throw createError({ statusCode: 400, message: 'quality must be "low", "standard", or "high"' })
}

export function toUploadJob(row: UploadJobRow, media: IngestedMedia | null = null): UploadJob {
  return { ...row, media }
}
```

- [ ] **Step 4: Create handler + config**

```ts
// server/api/media/uploads/index.post.ts
import { randomUUID } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore, StagedUploadTicket } from '~/server/services/media-store'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  parseKind,
  parseQuality,
  toUploadJob,
  type UploadJob
} from '~/server/services/media-uploads'

export interface CreateUploadInput {
  filename?: unknown
  kind?: unknown
  quality?: unknown
  mimeType?: unknown
  bytes?: unknown
}

export type CreatedUpload = UploadJob & { upload: StagedUploadTicket }

export async function handleCreateUpload(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: CreateUploadInput,
  opts: { maxBytes: number }
): Promise<CreatedUpload> {
  const kind = parseKind(input.kind)
  const quality = parseQuality(input.quality)

  const filename = typeof input.filename === 'string' ? input.filename.trim().slice(0, 255) : ''
  if (!filename) throw createError({ statusCode: 400, message: 'filename is required' })

  // Browser-supplied hint only (ffprobe decides for video). Browsers report an
  // empty type for unknown extensions (.mkv, .ts), so allow octet-stream.
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : ''
  if (!mimeType.startsWith(`${kind}/`) && mimeType !== 'application/octet-stream') {
    throw createError({ statusCode: 400, message: `mimeType must be ${kind}/* or application/octet-stream` })
  }

  const bytes = input.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
    throw createError({ statusCode: 400, message: 'bytes must be a positive integer' })
  }
  if (bytes > opts.maxBytes) {
    throw createError({
      statusCode: 413,
      message: `File exceeds the ${Math.floor(opts.maxBytes / 1024 ** 2)} MB upload limit`
    })
  }

  const id = randomUUID()
  const [row] = await db
    .insert(schema.mediaUploads)
    .values({ id, filename, kind, quality, mimeType, bytes, status: 'pending' })
    .returning()
  const upload = await store.createStagedUpload(id, { contentType: mimeType, bytes })
  return { ...toUploadJob(row), upload }
}

export function maxUploadBytesFromConfig(): number {
  const raw = Number((useRuntimeConfig() as any).maxUploadBytes)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES
}

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) ?? {}
  const result = await handleCreateUpload(useDb(), useMediaStore(), body, {
    maxBytes: maxUploadBytesFromConfig()
  })
  setResponseStatus(event, 201)
  return result
})
```

`nuxt.config.ts` — inside `runtimeConfig`, after `mailBaseUrl`:

```ts
    // Cap for dashboard uploads (POST /api/media/uploads). Bytes land in the
    // media store directly (presigned PUT on R2), so this is the only size
    // gate. MAX_UPLOAD_BYTES → NUXT_MAX_UPLOAD_BYTES at runtime (entrypoint.sh).
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 ** 3),
```

`scripts/entrypoint.sh` — after the `R2_SECRET_ACCESS_KEY` line (54):

```bash
map_runtime_env MAX_UPLOAD_BYTES      NUXT_MAX_UPLOAD_BYTES
```

`.env.example` — after the R2 block (line 13):

```
# Max size of a dashboard upload in bytes (default 2 GiB). Uploads go straight
# to the media store (presigned PUT on R2), so Cloudflare's 100 MB proxy cap
# does not apply; the R2 S3 endpoint accepts up to 5 GiB per single PUT.
# MAX_UPLOAD_BYTES=2147483648
```

- [ ] **Step 5: List / get / cancel handlers**

```ts
// server/api/media/uploads/index.get.ts
import { desc, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { ACTIVE_UPLOAD_STATUSES, toUploadJob, type UploadJob } from '~/server/services/media-uploads'

export async function handleListUploads(
  db: BetterSQLite3Database<typeof schema>,
  opts: { active: boolean }
): Promise<UploadJob[]> {
  const base = db.select().from(schema.mediaUploads)
  const rows = opts.active
    ? await base
        .where(inArray(schema.mediaUploads.status, [...ACTIVE_UPLOAD_STATUSES]))
        .orderBy(desc(schema.mediaUploads.createdAt))
    : await base.orderBy(desc(schema.mediaUploads.createdAt)).limit(50)
  return rows.map((r) => toUploadJob(r))
}

export default defineEventHandler((event) => {
  const q = getQuery(event)
  return handleListUploads(useDb(), { active: q.active === '1' || q.active === 'true' })
})
```

```ts
// server/api/media/uploads/[id].get.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { isUuid, toUploadJob, type UploadJob } from '~/server/services/media-uploads'

export async function handleGetUpload(
  db: BetterSQLite3Database<typeof schema>,
  id: string
): Promise<UploadJob> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  let media = null
  if (row.status === 'done' && row.mediaId != null) {
    media =
      (await db.select().from(schema.media).where(eq(schema.media.id, row.mediaId)).get()) ?? null
  }
  return toUploadJob(row, media)
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  return handleGetUpload(useDb(), id)
})
```

```ts
// server/api/media/uploads/[id].delete.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { isUuid } from '~/server/services/media-uploads'

/** Cancel a job that has not been completed yet (the client aborted the PUT). */
export async function handleCancelUpload(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: string
): Promise<void> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  if (row.status !== 'pending') {
    throw createError({ statusCode: 409, message: `Upload is ${row.status}; only pending uploads can be cancelled` })
  }
  await store.deleteStaged(id)
  await db.delete(schema.mediaUploads).where(eq(schema.mediaUploads.id, id))
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  await handleCancelUpload(useDb(), useMediaStore(), id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 6: Run** — `pnpm vitest run tests/api/media-uploads.test.ts` — Expected: PASS. Then `pnpm test` green.

- [ ] **Step 7: Commit**

```bash
git add server/services/media-uploads.ts server/api/media/uploads nuxt.config.ts scripts/entrypoint.sh .env.example tests/api/media-uploads.test.ts
git commit -m "feat(api): upload jobs — create/list/get/cancel + MAX_UPLOAD_BYTES"
```

---

### Task 7: Upload job API — complete + local file transport

**Files:**
- Create: `server/api/media/uploads/[id]/complete.post.ts`, `server/api/media/uploads/[id]/file.put.ts`
- Test: `tests/api/media-uploads.test.ts` (append)

**Interfaces:**
- Consumes: `IngestQueue.enqueue` (Task 5), `MediaStore.statStaged/putStaged/deleteStaged` (Task 3), helpers (Task 6).
- Produces:
  ```ts
  handleCompleteUpload(db, store, queue: Pick<IngestQueue, 'enqueue'>, id: string): Promise<UploadJob>
  handleReceiveUploadFile(db, store, id: string, body: Readable, contentLength: number | null, opts: { maxBytes: number }): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests** (append inside the top-level `describe('upload job API')`; add imports `import { handleCompleteUpload } from '~/server/api/media/uploads/[id]/complete.post'` and `import { handleReceiveUploadFile } from '~/server/api/media/uploads/[id]/file.put'`)

```ts
  describe('complete + file', () => {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    async function seedPending(bytes = 3, status: schema.UploadStatus = 'pending') {
      await db.insert(schema.mediaUploads).values({
        id: A, filename: 'f.png', kind: 'image', quality: 'standard', mimeType: 'image/png', bytes, status
      })
    }
    const jobRow = async () =>
      (await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, A)).get())!

    it('handleReceiveUploadFile stages the body when content-length matches', async () => {
      await seedPending(3)
      await handleReceiveUploadFile(db, store, A, Readable.from([Buffer.from('abc')]), 3, { maxBytes: MAX })
      expect(await store.statStaged(A)).toEqual({ bytes: 3 })
    })

    it('handleReceiveUploadFile rejects bad content-length / state / size', async () => {
      await seedPending(3)
      const body = () => Readable.from([Buffer.from('abc')])
      await expect(handleReceiveUploadFile(db, store, A, body(), null, { maxBytes: MAX })).rejects.toMatchObject({ statusCode: 400 })
      await expect(handleReceiveUploadFile(db, store, A, body(), 4, { maxBytes: MAX })).rejects.toMatchObject({ statusCode: 400 })
      await expect(handleReceiveUploadFile(db, store, A, body(), 3, { maxBytes: 2 })).rejects.toMatchObject({ statusCode: 413 })
      // body longer than declared → stream error, nothing staged
      await expect(
        handleReceiveUploadFile(db, store, A, Readable.from([Buffer.from('abcd')]), 3, { maxBytes: MAX })
      ).rejects.toThrow(/declared/)
      expect(await store.statStaged(A)).toBeNull()
      await db.update(schema.mediaUploads).set({ status: 'queued' }).where(eq(schema.mediaUploads.id, A))
      await expect(handleReceiveUploadFile(db, store, A, body(), 3, { maxBytes: MAX })).rejects.toMatchObject({ statusCode: 409 })
    })

    it('handleCompleteUpload verifies the staged size, queues, and enqueues', async () => {
      await seedPending(3)
      await store.putStaged(A, Readable.from([Buffer.from('abc')]), 'image/png')
      const enqueue = vi.fn()
      const job = await handleCompleteUpload(db, store, { enqueue }, A)
      expect(job.status).toBe('queued')
      expect(enqueue).toHaveBeenCalledWith(A)
      await expect(handleCompleteUpload(db, store, { enqueue }, A)).rejects.toMatchObject({ statusCode: 409 })
    })

    it('handleCompleteUpload fails the job when the staged object is missing or mismatched', async () => {
      await seedPending(3)
      const enqueue = vi.fn()
      await expect(handleCompleteUpload(db, store, { enqueue }, A)).rejects.toMatchObject({ statusCode: 400 })
      expect((await jobRow()).status).toBe('failed')
      expect((await jobRow()).error).toMatch(/not found/i)

      await db.update(schema.mediaUploads).set({ status: 'pending', error: null }).where(eq(schema.mediaUploads.id, A))
      await store.putStaged(A, Readable.from([Buffer.from('abcd')]), 'image/png')
      await expect(handleCompleteUpload(db, store, { enqueue }, A)).rejects.toMatchObject({ statusCode: 400 })
      expect((await jobRow()).status).toBe('failed')
      expect((await jobRow()).error).toMatch(/4 does not match declared 3/)
      expect(await store.statStaged(A)).toBeNull()
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('handleCompleteUpload 404s for unknown/invalid ids', async () => {
      await expect(handleCompleteUpload(db, store, { enqueue: vi.fn() }, 'nope')).rejects.toMatchObject({ statusCode: 404 })
    })
  })
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/api/media-uploads.test.ts` — Expected: the new `describe` fails (modules not found).

- [ ] **Step 3: Implement `complete`**

```ts
// server/api/media/uploads/[id]/complete.post.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import { useIngestQueue } from '~/server/services/ingest-queue-singleton'
import type { MediaStore } from '~/server/services/media-store'
import type { IngestQueue } from '~/server/services/media-ingest-queue'
import { isUuid, toUploadJob, type UploadJob } from '~/server/services/media-uploads'

/** The client finished its PUT: verify the staged object and hand the job to the worker. */
export async function handleCompleteUpload(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  queue: Pick<IngestQueue, 'enqueue'>,
  id: string
): Promise<UploadJob> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  if (row.status !== 'pending') {
    throw createError({ statusCode: 409, message: `Upload is already ${row.status}` })
  }

  const staged = await store.statStaged(id)
  if (!staged || staged.bytes !== row.bytes) {
    const message = !staged
      ? 'Uploaded file not found in storage'
      : `Uploaded size ${staged.bytes} does not match declared ${row.bytes}`
    await store.deleteStaged(id)
    await db
      .update(schema.mediaUploads)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(schema.mediaUploads.id, id))
    throw createError({ statusCode: 400, message })
  }

  const [updated] = await db
    .update(schema.mediaUploads)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(eq(schema.mediaUploads.id, id))
    .returning()
  queue.enqueue(id)
  return toUploadJob(updated)
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  return handleCompleteUpload(useDb(), useMediaStore(), useIngestQueue(), id)
})
```

- [ ] **Step 4: Implement the local file transport**

```ts
// server/api/media/uploads/[id]/file.put.ts
//
// Same-origin transport handed out by LocalDiskStore.createStagedUpload (dev /
// tests / any deployment without R2). Streams the raw request body into the
// store's staging area. With R2 the client PUTs to the presigned URL instead
// and this route is simply never offered.
import { Transform, type Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { isUuid } from '~/server/services/media-uploads'
import { maxUploadBytesFromConfig } from '../index.post'

export async function handleReceiveUploadFile(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: string,
  body: Readable,
  contentLength: number | null,
  opts: { maxBytes: number }
): Promise<void> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  if (row.status !== 'pending') {
    throw createError({ statusCode: 409, message: `Upload is already ${row.status}` })
  }
  if (contentLength == null || !Number.isInteger(contentLength) || contentLength !== row.bytes) {
    throw createError({ statusCode: 400, message: 'content-length must equal the declared bytes' })
  }
  if (contentLength > opts.maxBytes) {
    throw createError({ statusCode: 413, message: 'File exceeds the upload limit' })
  }

  // Belt and braces: a client can lie in content-length, so count the bytes.
  let seen = 0
  const declared = row.bytes
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > declared) return cb(new Error(`Body exceeds declared ${declared} bytes`))
      cb(null, chunk)
    }
  })
  await store.putStaged(id, body.pipe(limiter), row.mimeType)
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const lenHeader = getRequestHeader(event, 'content-length')
  const contentLength = lenHeader ? Number(lenHeader) : null
  await handleReceiveUploadFile(useDb(), useMediaStore(), id, event.node.req, contentLength, {
    maxBytes: maxUploadBytesFromConfig()
  })
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 5: Run** — `pnpm vitest run tests/api/media-uploads.test.ts` then `pnpm test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "server/api/media/uploads/[id]" tests/api/media-uploads.test.ts
git commit -m "feat(api): upload jobs — complete (verify + enqueue) and local PUT /file transport"
```

---

### Task 8: Client types, API client methods, XHR uploader

**Files:**
- Modify: `app/types/api.ts` (after `MediaDetail`, ~line 77), `app/composables/useApiClient.ts` (interface "media" block ~line 77–82 and the impl ~line 210–220)
- Create: `app/composables/useUploader.ts`
- Test: `tests/composables/useApiClient.test.ts` (append), `tests/composables/useUploader.test.ts`

**Interfaces:**
- Produces (types):
  ```ts
  export type UploadStatus = 'pending' | 'queued' | 'processing' | 'done' | 'failed' | 'expired'
  export interface UploadTicket { method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: number }
  export interface UploadJob { id: string; filename: string; kind: 'video' | 'image'; quality: 'low' | 'standard' | 'high'; mimeType: string; bytes: number; status: UploadStatus; error: string | null; mediaId: number | null; attempts: number; createdAt: string; updatedAt: string; media?: Media | null }
  export interface CreateUploadBody { filename: string; kind: 'video' | 'image'; quality: 'low' | 'standard' | 'high'; mimeType: string; bytes: number }
  export interface CreatedUpload extends UploadJob { upload: UploadTicket }
  ```
- Produces (ApiClient): `createUpload(body: CreateUploadBody): Promise<CreatedUpload>`, `completeUpload(id: string): Promise<UploadJob>`, `getUpload(id: string): Promise<UploadJob>`, `listActiveUploads(): Promise<UploadJob[]>`, `cancelUpload(id: string): Promise<void>`. **`uploadMedia` is removed** (Task 9 removes its only consumer in the same sweep — do both edits in Task 9 if you want the tree to stay consistent; here just add).
- Produces (uploader):
  ```ts
  export interface UploadRequest { method: 'PUT'; url: string; headers: Record<string, string>; file: Blob; onProgress?: (fraction: number) => void; signal?: AbortSignal }
  export class UploadError extends Error { status: number | null; aborted: boolean }
  export type XhrFactory = () => XMLHttpRequest
  export function uploadFile(req: UploadRequest, factory?: XhrFactory): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/composables/useApiClient.test.ts` (inside the existing `describe`):

```ts
  it('upload jobs: create/complete/get/listActive/cancel hit /api/media/uploads', async () => {
    const body = { filename: 'a.mp4', kind: 'video' as const, quality: 'standard' as const, mimeType: 'video/mp4', bytes: 10 }
    await client.createUpload(body)
    expect(fetchFn).toHaveBeenCalledWith('/api/media/uploads', { method: 'POST', body })
    await client.completeUpload('id-1')
    expect(fetchFn).toHaveBeenCalledWith('/api/media/uploads/id-1/complete', { method: 'POST' })
    await client.getUpload('id-1')
    expect(fetchFn).toHaveBeenCalledWith('/api/media/uploads/id-1', { method: 'GET' })
    await client.listActiveUploads()
    expect(fetchFn).toHaveBeenCalledWith('/api/media/uploads', { method: 'GET', query: { active: '1' } })
    await client.cancelUpload('id-1')
    expect(fetchFn).toHaveBeenCalledWith('/api/media/uploads/id-1', { method: 'DELETE' })
  })
```

New `tests/composables/useUploader.test.ts`:

```ts
// tests/composables/useUploader.test.ts
import { describe, it, expect, vi } from 'vitest'
import { uploadFile, UploadError } from '~/app/composables/useUploader'

class FakeXhr {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  withCredentials = true
  status = 0
  sent: unknown = null
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.sent = body }
  abort() { this.onabort?.() }
}

function setup() {
  const xhr = new FakeXhr()
  const factory = () => xhr as unknown as XMLHttpRequest
  const file = new Blob(['hello'])
  return { xhr, factory, file }
}

describe('uploadFile', () => {
  it('PUTs the file with exactly the ticket headers, no credentials, reporting progress', async () => {
    const { xhr, factory, file } = setup()
    const onProgress = vi.fn()
    const p = uploadFile(
      { method: 'PUT', url: 'https://r2.example/signed', headers: { 'content-type': 'video/mp4' }, file, onProgress },
      factory
    )
    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('https://r2.example/signed')
    expect(xhr.headers).toEqual({ 'content-type': 'video/mp4' })
    expect(xhr.withCredentials).toBe(false)
    expect(xhr.sent).toBe(file)
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 200 })
    xhr.status = 200
    xhr.onload!()
    await p
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([0.25, 1])
  })

  it('rejects with the HTTP status on non-2xx', async () => {
    const { xhr, factory, file } = setup()
    const p = uploadFile({ method: 'PUT', url: '/u', headers: {}, file }, factory)
    xhr.status = 403
    xhr.onload!()
    await expect(p).rejects.toMatchObject({ status: 403, aborted: false })
    await expect(p).rejects.toBeInstanceOf(UploadError)
  })

  it('rejects on network error and on abort via AbortSignal', async () => {
    const a = setup()
    const p1 = uploadFile({ method: 'PUT', url: '/u', headers: {}, file: a.file }, a.factory)
    a.xhr.onerror!()
    await expect(p1).rejects.toMatchObject({ status: null, aborted: false })

    const b = setup()
    const ctrl = new AbortController()
    const p2 = uploadFile({ method: 'PUT', url: '/u', headers: {}, file: b.file, signal: ctrl.signal }, b.factory)
    ctrl.abort()
    await expect(p2).rejects.toMatchObject({ aborted: true })
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/composables` — Expected: FAIL (missing methods / module).

- [ ] **Step 3: Types** — append to `app/types/api.ts` right after `MediaDetail`:

```ts
export type UploadStatus = 'pending' | 'queued' | 'processing' | 'done' | 'failed' | 'expired'

/** Where the browser must PUT the bytes (presigned R2 URL or same-origin /file). */
export interface UploadTicket {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: number
}

export interface UploadJob {
  id: string
  filename: string
  kind: 'video' | 'image'
  quality: 'low' | 'standard' | 'high'
  mimeType: string
  bytes: number
  status: UploadStatus
  error: string | null
  mediaId: number | null
  attempts: number
  createdAt: string
  updatedAt: string
  media?: Media | null
}

export interface CreateUploadBody {
  filename: string
  kind: 'video' | 'image'
  quality: 'low' | 'standard' | 'high'
  mimeType: string
  bytes: number
}

export interface CreatedUpload extends UploadJob {
  upload: UploadTicket
}
```

- [ ] **Step 4: API client** — import `CreateUploadBody, CreatedUpload, UploadJob` in the type import block; in the `// media` section of the interface add:

```ts
  createUpload(body: CreateUploadBody): Promise<CreatedUpload>
  completeUpload(id: string): Promise<UploadJob>
  getUpload(id: string): Promise<UploadJob>
  listActiveUploads(): Promise<UploadJob[]>
  cancelUpload(id: string): Promise<void>
```

and in `createApiClient`, after `uploadMedia`:

```ts
    createUpload: (body) =>
      fetch<CreatedUpload>('/api/media/uploads', { method: 'POST', body }),
    completeUpload: (id) =>
      fetch<UploadJob>(`/api/media/uploads/${id}/complete`, { method: 'POST' }),
    getUpload: (id) => fetch<UploadJob>(`/api/media/uploads/${id}`, { method: 'GET' }),
    listActiveUploads: () =>
      fetch<UploadJob[]>('/api/media/uploads', { method: 'GET', query: { active: '1' } }),
    cancelUpload: (id) => fetch<void>(`/api/media/uploads/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 5: Uploader**

```ts
// app/composables/useUploader.ts
//
// Raw-bytes upload with progress. fetch() has no upload progress, so this is
// XMLHttpRequest. Used for both transports handed out by POST /api/media/uploads:
// a cross-origin presigned PUT to R2 (must NOT carry cookies and must send
// exactly the signed headers) and the same-origin PUT /api/media/uploads/:id/file
// (browser attaches the session cookie itself for same-origin requests).

export interface UploadRequest {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  file: Blob
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly aborted = false
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export type XhrFactory = () => XMLHttpRequest

export function uploadFile(
  req: UploadRequest,
  factory: XhrFactory = () => new XMLHttpRequest()
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = factory()
    xhr.open(req.method, req.url, true)
    xhr.withCredentials = false
    for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) req.onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        req.onProgress?.(1)
        resolve()
      } else {
        reject(new UploadError(`Upload failed with HTTP ${xhr.status}`, xhr.status))
      }
    }
    xhr.onerror = () => reject(new UploadError('Network error during upload', null))
    xhr.onabort = () => reject(new UploadError('Upload cancelled', null, true))

    if (req.signal) {
      if (req.signal.aborted) {
        xhr.abort()
        return
      }
      req.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(req.file)
  })
}
```

- [ ] **Step 6: Run** — `pnpm vitest run tests/composables` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/types/api.ts app/composables/useApiClient.ts app/composables/useUploader.ts tests/composables/useApiClient.test.ts tests/composables/useUploader.test.ts
git commit -m "feat(client): upload-job API methods + XHR uploader with progress/abort"
```

---

### Task 9: Pinia media store — `startUpload` + polling placeholders

**Files:**
- Modify: `app/stores/media.ts` (rewrite), `app/composables/useApiClient.ts` (remove `uploadMedia` from the interface + impl)
- Test: `tests/stores/media.test.ts`

**Interfaces:**
- Consumes: `uploadFile`/`UploadRequest` (Task 8), API client methods (Task 8).
- Produces (store):
  ```ts
  state: { list, uploads: UploadJob[], failedUploads: UploadJob[], loading, error, _api, _pollTimer }
  export const POLL_INTERVAL_MS = 3000
  startUpload(file: File, opts: { kind; quality; onProgress?; signal?; uploadFn?: typeof uploadFile }): Promise<UploadJob>
  trackUpload(job: UploadJob): void
  pollUploads(): Promise<void>      // seed from ?active=1, then start the timer
  tick(): Promise<void>             // one polling round (exposed for tests)
  applyUpload(job: UploadJob): void
  takeFailedUploads(): UploadJob[]
  stopPolling(): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/stores/media.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMediaStore } from '~/app/stores/media'
import type { UploadJob } from '~/app/types/api'

function job(over: Partial<UploadJob> = {}): UploadJob {
  return {
    id: 'j1', filename: 'a.mp4', kind: 'video', quality: 'standard', mimeType: 'video/mp4', bytes: 10,
    status: 'queued', error: null, mediaId: null, attempts: 0,
    createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z', ...over
  }
}
const ticket = { method: 'PUT' as const, url: '/api/media/uploads/j1/file', headers: { 'content-type': 'video/mp4' }, expiresAt: 1 }

describe('useMediaStore uploads', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('startUpload: create → PUT via uploadFn → complete → tracked', async () => {
    const store = useMediaStore()
    const api = {
      createUpload: vi.fn().mockResolvedValue({ ...job({ status: 'pending' }), upload: ticket }),
      completeUpload: vi.fn().mockResolvedValue(job({ status: 'queued' })),
      cancelUpload: vi.fn(),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    const uploadFn = vi.fn().mockResolvedValue(undefined)
    const file = new File([new Uint8Array(10)], 'a.mp4', { type: 'video/mp4' })
    const onProgress = vi.fn()
    const res = await store.startUpload(file, { kind: 'video', quality: 'standard', onProgress, uploadFn })
    expect(api.createUpload).toHaveBeenCalledWith({ filename: 'a.mp4', kind: 'video', quality: 'standard', mimeType: 'video/mp4', bytes: 10 })
    expect(uploadFn).toHaveBeenCalledWith(expect.objectContaining({ ...ticket, file, onProgress }))
    expect(api.completeUpload).toHaveBeenCalledWith('j1')
    expect(res.status).toBe('queued')
    expect(store.uploads.map((u) => u.id)).toEqual(['j1'])
    expect(api.cancelUpload).not.toHaveBeenCalled()
    store.stopPolling()
  })

  it('startUpload cancels the job (best effort) and rethrows when the PUT fails', async () => {
    const store = useMediaStore()
    const api = {
      createUpload: vi.fn().mockResolvedValue({ ...job({ status: 'pending' }), upload: ticket }),
      completeUpload: vi.fn(),
      cancelUpload: vi.fn().mockRejectedValue(new Error('offline'))
    }
    store.$patch({ _api: api as any })
    const uploadFn = vi.fn().mockRejectedValue(new Error('HTTP 403'))
    await expect(
      store.startUpload(new File(['x'], 'a.mp4', { type: 'video/mp4' }), { kind: 'video', quality: 'low', uploadFn })
    ).rejects.toThrow('HTTP 403')
    expect(api.cancelUpload).toHaveBeenCalledWith('j1')
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(store.uploads).toEqual([])
  })

  it('tick(): done → refresh + drop; failed → failedUploads; 404 → drop', async () => {
    const store = useMediaStore()
    const api = {
      listMedia: vi.fn().mockResolvedValue([]),
      getUpload: vi.fn(async (id: string) => {
        if (id === 'j1') return job({ id: 'j1', status: 'done', mediaId: 5 })
        if (id === 'j2') return job({ id: 'j2', status: 'failed', error: 'boom' })
        throw Object.assign(new Error('not found'), { status: 404 })
      })
    }
    store.$patch({ _api: api as any, uploads: [job({ id: 'j1' }), job({ id: 'j2' }), job({ id: 'j3' })] })
    await store.tick()
    expect(api.listMedia).toHaveBeenCalledTimes(1)
    expect(store.uploads).toEqual([])
    expect(store.takeFailedUploads().map((j) => j.id)).toEqual(['j2'])
    expect(store.failedUploads).toEqual([])
    store.stopPolling()
  })

  it('pollUploads seeds from the active list and keeps polling every 3s while active', async () => {
    const store = useMediaStore()
    const api = {
      listActiveUploads: vi.fn().mockResolvedValue([job({ id: 'j1', status: 'processing' })]),
      getUpload: vi.fn().mockResolvedValue(job({ id: 'j1', status: 'processing' })),
      listMedia: vi.fn().mockResolvedValue([])
    }
    store.$patch({ _api: api as any })
    await store.pollUploads()
    expect(store.uploads.map((u) => u.id)).toEqual(['j1'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getUpload).toHaveBeenCalledTimes(2)
    store.stopPolling()
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.getUpload).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/stores/media.test.ts` — Expected: FAIL (`startUpload is not a function`).

- [ ] **Step 3: Rewrite the store**

```ts
// app/stores/media.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import { uploadFile } from '~/app/composables/useUploader'
import type { MediaListRow, UploadJob } from '~/app/types/api'

export const POLL_INTERVAL_MS = 3000
const ACTIVE = new Set<UploadJob['status']>(['pending', 'queued', 'processing'])

interface State {
  list: MediaListRow[]
  /** In-flight upload jobs (pending/queued/processing), newest first. */
  uploads: UploadJob[]
  /** Terminal failures the page has not toasted yet. */
  failedUploads: UploadJob[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    'listMedia' | 'deleteMedia' | 'createUpload' | 'completeUpload' | 'getUpload' | 'listActiveUploads' | 'cancelUpload'
  >
  _pollTimer: ReturnType<typeof setTimeout> | null
}

export const useMediaStore = defineStore('media', {
  state: (): State => ({
    list: [],
    uploads: [],
    failedUploads: [],
    loading: false,
    error: null,
    _api: useApiClient(),
    _pollTimer: null
  }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listMedia()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },

    async delete(id: number, opts: { force?: boolean } = {}): Promise<void> {
      await this._api.deleteMedia(id, opts)
      this.list = this.list.filter((m) => m.id !== id)
    },

    /** create job → PUT bytes to the ticket → complete. Resolves with the queued job. */
    async startUpload(
      file: File,
      opts: {
        kind: 'video' | 'image'
        quality: 'low' | 'standard' | 'high'
        onProgress?: (fraction: number) => void
        signal?: AbortSignal
        uploadFn?: typeof uploadFile
      }
    ): Promise<UploadJob> {
      const created = await this._api.createUpload({
        filename: file.name,
        kind: opts.kind,
        quality: opts.quality,
        mimeType: file.type || 'application/octet-stream',
        bytes: file.size
      })
      try {
        await (opts.uploadFn ?? uploadFile)({
          ...created.upload,
          file,
          onProgress: opts.onProgress,
          signal: opts.signal
        })
      } catch (err) {
        // Best effort: free the pending row + any partial staged object.
        await this._api.cancelUpload(created.id).catch(() => {})
        throw err
      }
      const job = await this._api.completeUpload(created.id)
      this.trackUpload(job)
      return job
    },

    trackUpload(job: UploadJob) {
      this.applyUpload(job)
      this.schedulePoll()
    },

    /** Seed from the server's active list (survives reloads) and start polling. */
    async pollUploads() {
      const active = await this._api.listActiveUploads()
      for (const j of active) this.applyUpload(j)
      this.schedulePoll()
    },

    schedulePoll() {
      if (this._pollTimer || this.uploads.length === 0) return
      this._pollTimer = setTimeout(() => {
        this._pollTimer = null
        void this.tick()
      }, POLL_INTERVAL_MS)
    },

    /** One polling round over every tracked job. */
    async tick() {
      let refresh = false
      for (const tracked of [...this.uploads]) {
        try {
          const fresh = await this._api.getUpload(tracked.id)
          this.applyUpload(fresh)
          if (fresh.status === 'done') refresh = true
        } catch (err: any) {
          const status = err?.status ?? err?.statusCode ?? err?.response?.status
          if (status === 404) this.uploads = this.uploads.filter((u) => u.id !== tracked.id)
          // other errors: keep the job, retry next round
        }
      }
      if (refresh) await this.refresh()
      this.schedulePoll()
    },

    applyUpload(job: UploadJob) {
      const rest = this.uploads.filter((u) => u.id !== job.id)
      if (ACTIVE.has(job.status)) {
        this.uploads = [job, ...rest]
        return
      }
      this.uploads = rest
      if (job.status === 'failed' || job.status === 'expired') this.failedUploads.push(job)
    },

    takeFailedUploads(): UploadJob[] {
      const out = this.failedUploads
      this.failedUploads = []
      return out
    },

    stopPolling() {
      if (this._pollTimer) clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  }
})
```

Then in `app/composables/useApiClient.ts` delete the `uploadMedia(body: FormData): Promise<Media>` interface line and the `uploadMedia: (body) => fetch<Media>('/api/media', { method: 'POST', body }),` implementation, and delete the `it('uploadMedia sends FormData as multipart', …)` case in `tests/composables/useApiClient.test.ts` (~line 65). Grep `uploadMedia` — nothing may remain except `MediaUploadDialog.vue`'s `store.upload(...)` call, which Task 10 replaces (tests pass meanwhile; `pnpm build` only passes after Task 10).

- [ ] **Step 4: Run** — `pnpm vitest run tests/stores/media.test.ts tests/composables` — Expected: PASS. `pnpm test` green.

- [ ] **Step 5: Commit**

```bash
git add app/stores/media.ts app/composables/useApiClient.ts tests/stores/media.test.ts
git commit -m "feat(dashboard): media store drives async uploads + polls job status"
```

---

### Task 10: `MediaUploadDialog.vue` — sequential uploads with progress + cancel (+ i18n)

**Files:**
- Modify: `app/components/MediaUploadDialog.vue` (rewrite script + file list), `i18n/locales/en.json`, `i18n/locales/uk.json` (`components.mediaUploadDialog`)

**Interfaces:**
- Consumes: `store.startUpload(file, { kind, quality, onProgress, signal })` (Task 9).
- Produces: emits `uploaded` once ≥1 file is queued; closes itself when every file is queued.

No unit test (SFC); verified by `pnpm build` + the manual check in Task 13.

- [ ] **Step 1: i18n strings**

In `i18n/locales/en.json` → `components.mediaUploadDialog` replace `description` and add keys (keep the existing ones):

```json
"description": "Videos and images. Files upload straight to storage and are processed in the background — you can close this dialog once they are queued.",
"uploading": "Uploading… {pct}%",
"queued": "Queued for processing",
"failed": "Failed",
"cancelUpload": "Cancel upload",
"queuedFiles": "{n} file queued for processing | {n} files queued for processing | {n} files queued for processing",
```

In `i18n/locales/uk.json` the same keys:

```json
"description": "Відео та зображення. Файли завантажуються напряму в сховище й обробляються у фоні — діалог можна закрити, щойно вони в черзі.",
"uploading": "Завантаження… {pct}%",
"queued": "У черзі на обробку",
"failed": "Помилка",
"cancelUpload": "Скасувати завантаження",
"queuedFiles": "{n} файл у черзі на обробку | {n} файли в черзі на обробку | {n} файлів у черзі на обробку",
```

- [ ] **Step 2: Rewrite the `<script setup>`**

```ts
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'uploaded'): void
}>()

type ItemState = 'idle' | 'uploading' | 'queued' | 'failed'
interface Item {
  file: File
  kind: 'video' | 'image'
  state: ItemState
  progress: number // 0..100
  error?: string
}

const store = useMediaStore()
const toast = useToast()
const { t } = useI18n()
const items = ref<Item[]>([])
const uploading = ref(false)
const dragOver = ref(false)
const quality = ref<'low' | 'standard' | 'high'>('standard')
let controller: AbortController | null = null

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts)$/i

// Browsers report an empty type for unknown extensions (.mkv, .ts) — fall
// back to the extension so such clips are still treated as video.
function kindOf(f: File): 'video' | 'image' {
  if (f.type.startsWith('video/')) return 'video'
  if (f.type.startsWith('image/')) return 'image'
  return VIDEO_EXT.test(f.name) ? 'video' : 'image'
}

function add(files: Iterable<File>) {
  for (const f of files) items.value.push({ file: f, kind: kindOf(f), state: 'idle', progress: 0 })
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  if (e.dataTransfer) add(Array.from(e.dataTransfer.files))
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) add(Array.from(input.files))
  input.value = ''
}

function remove(i: number) {
  if (uploading.value) return
  items.value.splice(i, 1)
}

async function upload() {
  const todo = items.value.filter((it) => it.state !== 'queued')
  if (todo.length === 0 || uploading.value) return
  uploading.value = true
  controller = new AbortController()
  let queued = 0
  for (const it of todo) {
    it.state = 'uploading'
    it.progress = 0
    it.error = undefined
    try {
      await store.startUpload(it.file, {
        kind: it.kind,
        quality: quality.value,
        signal: controller.signal,
        onProgress: (p) => {
          it.progress = Math.round(p * 100)
        }
      })
      it.state = 'queued'
      it.progress = 100
      queued++
    } catch (err: any) {
      it.state = 'failed'
      it.error = err.data?.message ?? err.message
      if (err.aborted) break
      toast.add({
        title: t('components.mediaUploadDialog.uploadFailed', { name: it.file.name }),
        description: it.error,
        color: 'error'
      })
    }
  }
  uploading.value = false
  controller = null
  if (queued > 0) {
    toast.add({
      title: t('components.mediaUploadDialog.queuedFiles', queued, { named: { n: queued } }),
      color: 'success'
    })
    emit('uploaded')
  }
  if (items.value.every((it) => it.state === 'queued')) {
    items.value = []
    emit('update:modelValue', false)
  } else {
    // Keep failed/aborted rows so the user can retry them.
    items.value = items.value.filter((it) => it.state !== 'queued')
  }
}

function cancel() {
  if (uploading.value) {
    controller?.abort()
    return
  }
  emit('update:modelValue', false)
}

const pendingCount = computed(() => items.value.filter((it) => it.state !== 'queued').length)
</script>
```

- [ ] **Step 3: Update the template's file list and buttons**

Replace the `<ul v-if="files.length > 0" …>` block with:

```html
        <ul v-if="items.length > 0" class="mt-4 max-h-64 space-y-2 overflow-y-auto">
          <li
            v-for="(it, i) in items"
            :key="i"
            class="rounded border border-(--ui-border) bg-(--ui-bg) p-2 text-sm"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 min-w-0">
                <UIcon
                  :name="it.kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
                  class="size-4 text-(--ui-text-muted) shrink-0"
                />
                <span class="truncate">{{ it.file.name }}</span>
                <span class="text-xs text-(--ui-text-muted) shrink-0">
                  {{ (it.file.size / 1024 / 1024).toFixed(1) }} MB
                </span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span v-if="it.state === 'uploading'" class="text-xs text-(--ui-text-muted)">
                  {{ $t('components.mediaUploadDialog.uploading', { pct: it.progress }) }}
                </span>
                <UBadge v-else-if="it.state === 'queued'" size="sm" color="success" variant="soft">
                  {{ $t('components.mediaUploadDialog.queued') }}
                </UBadge>
                <UBadge v-else-if="it.state === 'failed'" size="sm" color="error" variant="soft" :title="it.error">
                  {{ $t('components.mediaUploadDialog.failed') }}
                </UBadge>
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="uploading"
                  @click="remove(i)"
                />
              </div>
            </div>
            <UProgress v-if="it.state === 'uploading'" :model-value="it.progress" :max="100" size="xs" class="mt-2" />
            <p v-if="it.state === 'failed' && it.error" class="mt-1 text-xs text-(--ui-error)">{{ it.error }}</p>
          </li>
        </ul>
```

Replace the footer buttons with:

```html
        <div class="mt-6 flex justify-end gap-2">
          <UButton variant="ghost" @click="cancel">
            {{ uploading ? $t('components.mediaUploadDialog.cancelUpload') : $t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            :loading="uploading"
            :disabled="pendingCount === 0 || uploading"
            @click="upload"
          >
            {{ pendingCount > 0 ? $t('components.mediaUploadDialog.uploadButtonCount', { n: pendingCount }) : $t('components.mediaUploadDialog.uploadButton') }}
          </UButton>
        </div>
```

Everything else in the template (modal, drop zone, quality select) stays. The drop zone's `<input type="file">` keeps calling `onPick`.

- [ ] **Step 4: Build** — `pnpm build` — Expected: succeeds with no Vue compiler errors (Task 9 removed `store.upload`, so any leftover reference would fail here).

- [ ] **Step 5: Commit**

```bash
git add app/components/MediaUploadDialog.vue i18n/locales/en.json i18n/locales/uk.json
git commit -m "feat(dashboard): upload dialog streams files one by one with progress + cancel"
```

---

### Task 11: Processing placeholders on the media page (+ i18n)

**Files:**
- Create: `app/components/MediaProcessingCard.vue`
- Modify: `app/pages/media.vue`, `i18n/locales/en.json`, `i18n/locales/uk.json` (`media.*`)

**Interfaces:**
- Consumes: `store.uploads`, `store.pollUploads()`, `store.stopPolling()`, `store.takeFailedUploads()`, `store.failedUploads` (Task 9); `formatBytes` (auto-imported from `app/composables/useFmtBytes.ts`).

- [ ] **Step 1: i18n** — add under `media` in `en.json`:

```json
"uploadStatus": { "pending": "Uploading", "queued": "Queued", "processing": "Processing…" },
"processingFailed": "Processing failed: {name}"
```

and in `uk.json`:

```json
"uploadStatus": { "pending": "Завантаження", "queued": "У черзі", "processing": "Обробка…" },
"processingFailed": "Помилка обробки: {name}"
```

- [ ] **Step 2: The card**

```vue
<!-- app/components/MediaProcessingCard.vue -->
<script setup lang="ts">
import type { UploadJob } from '~/app/types/api'

const props = defineProps<{ job: UploadJob }>()
</script>

<template>
  <div class="relative overflow-hidden soft-card opacity-90" :title="props.job.filename">
    <div class="flex aspect-video items-center justify-center bg-zinc-900 text-(--ui-text-muted)">
      <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin" />
    </div>
    <div class="p-3">
      <p class="truncate text-sm font-medium">{{ props.job.filename }}</p>
      <div class="mt-1 flex items-center justify-between text-xs text-(--ui-text-muted)">
        <span>{{ formatBytes(props.job.bytes) }}</span>
        <UBadge size="sm" color="neutral" variant="soft">
          {{ $t(`media.uploadStatus.${props.job.status}`) }}
        </UBadge>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Page wiring** — in `app/pages/media.vue`:

Replace `onMounted(() => store.refresh())` with:

```ts
onMounted(() => {
  store.refresh()
  store.pollUploads()
})
onUnmounted(() => store.stopPolling())

// Terminal failures surface once as toasts (the placeholder card disappears).
watch(
  () => store.failedUploads.length,
  (n) => {
    if (n === 0) return
    for (const j of store.takeFailedUploads()) {
      toast.add({
        title: t('media.processingFailed', { name: j.filename }),
        description: j.error ?? '',
        color: 'error'
      })
    }
  }
)
```

Change the empty-state guard and the grid:

```html
    <USkeleton v-if="store.loading && store.list.length === 0 && store.uploads.length === 0" class="h-32 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0 && store.uploads.length === 0"
      …unchanged…
    </EmptyState>
    <div v-else class="grid grid-cols-4 gap-4">
      <MediaProcessingCard v-for="j in store.uploads" :key="j.id" :job="j" />
      <MediaCard
        v-for="m in store.list"
        :key="m.id"
        :media="m"
        @select="selectedId = m.id"
        @delete="remove"
      />
    </div>
```

`<MediaUploadDialog v-model="showUpload" @uploaded="store.refresh()" />` stays as is.

- [ ] **Step 4: Build + full suite** — `pnpm build && pnpm test` — Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add app/components/MediaProcessingCard.vue app/pages/media.vue i18n/locales/en.json i18n/locales/uk.json
git commit -m "feat(dashboard): processing placeholder cards for in-flight uploads"
```

---

### Task 12: Ops + docs — R2 CORS script, README, CLAUDE.md

**Files:**
- Create: `scripts/r2-cors.mjs`
- Modify: `README.md` (Environment variables §, "Known limitations" §, Media §), `CLAUDE.md` (Architecture gotchas)

- [ ] **Step 1: CORS script** (plain `.mjs` so it runs with bare `node` inside the prod container, where `@aws-sdk/client-s3` already lives in `/app/node_modules`; accepts both the plain and the `NUXT_`-bridged env names)

```js
// scripts/r2-cors.mjs
//
// One-off: install the CORS rule that lets the dashboard PUT presigned uploads
// straight to the R2 S3 endpoint (see docs/superpowers/specs/2026-08-22-direct-
// r2-upload-async-ingest-design.md). Idempotent — re-running replaces the rule.
//
// Local:   set -a; . ./.env; set +a; node scripts/r2-cors.mjs --origin https://app.lanka.live
// Prod:    docker cp scripts/r2-cors.mjs lanka:/tmp/r2-cors.mjs \
//          && docker exec -w /app lanka node /tmp/r2-cors.mjs --origin https://app.lanka.live
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3'

function env(...names) {
  for (const n of names) if (process.env[n]) return process.env[n]
  console.error(`Missing env: ${names.join(' or ')}`)
  process.exit(1)
}

const originArg = process.argv.indexOf('--origin')
const origin = (originArg > -1 ? process.argv[originArg + 1] : env('APP_BASE_URL', 'NUXT_MAIL_BASE_URL')).replace(/\/$/, '')
if (!/^https?:\/\//.test(origin)) {
  console.error(`--origin must be an absolute URL, got: ${origin}`)
  process.exit(1)
}

const Bucket = env('R2_BUCKET', 'NUXT_R2_BUCKET')
const s3 = new S3Client({
  region: 'auto',
  endpoint: env('R2_ENDPOINT', 'NUXT_R2_ENDPOINT'),
  credentials: {
    accessKeyId: env('R2_ACCESS_KEY_ID', 'NUXT_R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY', 'NUXT_R2_SECRET_ACCESS_KEY')
  }
})

await s3.send(
  new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: [origin],
          AllowedMethods: ['PUT'],
          AllowedHeaders: ['content-type'],
          MaxAgeSeconds: 3600
        }
      ]
    }
  })
)
const { CORSRules } = await s3.send(new GetBucketCorsCommand({ Bucket }))
console.log(`CORS on ${Bucket}:`, JSON.stringify(CORSRules, null, 2))
```

- [ ] **Step 2: README** — (a) in "Environment variables" add a row/bullet `MAX_UPLOAD_BYTES` — "cap for dashboard uploads, default 2147483648 (2 GiB)"; (b) replace the first "Known limitations" bullet with:

```markdown
- **Dashboard uploads bypass Cloudflare.** `app.lanka.live` sits behind Cloudflare's
  proxy, which rejects request bodies over 100 MB (Free/Pro plan). Uploads therefore
  go `POST /api/media/uploads` → presigned **PUT straight to the R2 S3 endpoint**
  (up to 5 GiB per object; app cap `MAX_UPLOAD_BYTES`, default 2 GiB) → `…/complete`,
  and the transcode runs in a background worker (no request is held open). This
  needs a **one-time CORS rule on the bucket** — run `scripts/r2-cors.mjs` (see
  "Common tasks") or paste in the Cloudflare dashboard (R2 → bucket → Settings →
  CORS policy):
  ```json
  [{ "AllowedOrigins": ["https://app.lanka.live"], "AllowedMethods": ["PUT"],
     "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
  ```
  Without it the browser's PUT fails with a CORS error and the job stays `pending`
  (expired automatically after 24 h). Staged objects live under `uploads/<uuid>` and
  are deleted once ingested.
```

(c) in "Common tasks" add: `` - Install/refresh the R2 CORS rule: `docker cp scripts/r2-cors.mjs lanka:/tmp/ && docker exec -w /app lanka node /tmp/r2-cors.mjs --origin https://app.lanka.live` ``; (d) in the "Media" endpoints section list the six new routes one line each (`POST /api/media/uploads`, `PUT /api/media/uploads/:id/file` (local-disk only), `POST /api/media/uploads/:id/complete`, `GET /api/media/uploads/:id`, `GET /api/media/uploads?active=1`, `DELETE /api/media/uploads/:id`) and mark `POST /api/media` as legacy/sync.

- [ ] **Step 3: CLAUDE.md** — add one bullet under "Architecture gotchas":

```markdown
- **Media uploads are async and direct-to-store.** The dashboard never POSTs file bytes to the app: `POST /api/media/uploads` creates a `media_uploads` job and returns a ticket — a **presigned PUT to the R2 S3 endpoint** (`uploads/<uuid>`, 1 h, `ContentType` signed) or, on `LocalDiskStore`, `PUT /api/media/uploads/:id/file`. `…/complete` verifies the staged size and enqueues; `server/services/media-ingest-queue.ts` (single in-process worker, started by `server/plugins/ingest-worker.ts`) runs the same `ingestMedia()` and deletes the staged object. Why: Cloudflare's proxy caps bodies at 100 MB and times out at 100 s — the presigned PUT must go to `<account>.r2.cloudflarestorage.com`, **never** through `app.lanka.live` or `media.lanka.live`. Prod needs the bucket CORS rule (`scripts/r2-cors.mjs`). One Nitro instance is assumed (no cross-process job locking). The sync `POST /api/media` still exists for curl/scripts only.
```

- [ ] **Step 4: Commit** (stage only the files from this task; if `CLAUDE.md` already carries the user's unrelated uncommitted hunk, use `git add -p CLAUDE.md` and pick only the new bullet)

```bash
git add scripts/r2-cors.mjs README.md
git add -p CLAUDE.md
git commit -m "docs(media): direct-to-R2 upload flow, CORS script, MAX_UPLOAD_BYTES"
```

---

### Task 13: Local end-to-end verification (production build, local-disk store)

**Files:** none (verification only).

- [ ] **Step 1: Full gates** — `pnpm test && pnpm build` — Expected: all tests pass; build succeeds.

- [ ] **Step 2: Migrate the dev DB and start the prod build** — `pnpm db:migrate` then `HOST=0.0.0.0 PORT=5100 node .output/server/index.mjs` (background). Expected log: `[ingest-queue]` lines absent (nothing to recover) and `Listening on http://0.0.0.0:5100`.

- [ ] **Step 3: API-level smoke with curl** (login with the dev seed account; see CLAUDE.md "Dev login")

```bash
B=http://localhost:5100; J=/tmp/lanka-cookies.txt
curl -s -c $J -H 'content-type: application/json' -d '{"email":"super@lanka.live","password":"lanka-dev"}' $B/api/auth/login >/dev/null
head -c 3M /dev/urandom > /tmp/probe.png   # "image" — ingest stores it as-is, no ffmpeg needed
CREATE=$(curl -s -b $J -H 'content-type: application/json' -d '{"filename":"probe.png","kind":"image","quality":"standard","mimeType":"image/png","bytes":3145728}' $B/api/media/uploads)
echo "$CREATE"; ID=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
URL=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["upload"]["url"])')
curl -s -o /dev/null -w 'PUT %{http_code}\n' -b $J -X PUT -H 'content-type: image/png' --data-binary @/tmp/probe.png "$B$URL"   # expect 204
curl -s -b $J -X POST "$B/api/media/uploads/$ID/complete"; echo   # expect "status":"queued"
sleep 2; curl -s -b $J "$B/api/media/uploads/$ID"; echo             # expect "status":"done","mediaId":N,"media":{...}
curl -s -b $J "$B/api/media/uploads?active=1"; echo                 # expect []
ls data/media/.uploads/ 2>/dev/null | wc -l                           # expect 0 (staged file deleted)
```

Also exercise the negative paths: `complete` again → 409; create with `bytes: 9999999999` → 413; `DELETE` a fresh pending job → 204 and the row is gone.

- [ ] **Step 4: Video path** — repeat with a real small `.mp4` (`kind: "video"`, `mimeType: "video/mp4"`): status should go `queued` → `processing` → `done` and the resulting media row has `mimeType: "video/mp4"`, `width/height` set, `quality` as requested.

- [ ] **Step 5: Dashboard check** — open `http://localhost:5100/media`, upload two files via the dialog: per-file progress visible, dialog closes when both are queued, placeholder cards appear and are replaced by real cards within a few seconds. Reload mid-processing: the placeholder is still there. (Use a browser by hand — do not drive the dev SPA with chrome-devtools.)

- [ ] **Step 6: Stop the server.** Nothing to commit.

---

### Task 14: Prod rollout (requires the user's go-ahead before Step 2)

- [ ] **Step 1: Push** — `git push origin main`.
- [ ] **Step 2: Deploy** — `ssh lanka-prod 'cd /opt/lanka && nohup setsid ./scripts/deploy.sh > /root/lanka-deploy-$(date +%Y%m%d-%H%M%S).log 2>&1 < /dev/null &'`; poll the log until `Healthy after N attempt(s)`; confirm `sqlite3 /opt/lanka/data/signage.db ".tables"` lists `media_uploads` and `docker logs lanka` has no `[ingest-queue]` errors.
- [ ] **Step 3: CORS** — `scp scripts/r2-cors.mjs lanka-prod:/tmp/ && ssh lanka-prod 'docker cp /tmp/r2-cors.mjs lanka:/tmp/r2-cors.mjs && docker exec -w /app lanka node /tmp/r2-cors.mjs --origin https://app.lanka.live'` — Expected: prints the single rule with `AllowedOrigins: ["https://app.lanka.live"]`.
- [ ] **Step 4: Preflight from outside** — `curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS -H 'Origin: https://app.lanka.live' -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: content-type' https://<account>.r2.cloudflarestorage.com/lanka-media/uploads/x` → expect `200` with `access-control-allow-origin: https://app.lanka.live` (`-D -` to see headers).
- [ ] **Step 5: Real test** — from the dashboard at `https://app.lanka.live/media`, upload a **>100 MB** video: progress bar → "Queued" → placeholder "Processing…" → real card; `docker logs lanka` shows no errors; the bucket's `uploads/` prefix is empty afterwards (`aws s3 ls`-equivalent via the script or the Cloudflare dashboard).
- [ ] **Step 6: Record** the outcome in the memory note (`keep-local-dev-separate-from-prod`) deploy log.
