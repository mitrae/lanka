// tests/services/media-ingest-queue.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import {
  createIngestQueue,
  cleanupStaleTmp,
  isPermanentIngestError,
  requiredScratchBytes,
  MAX_ATTEMPTS,
  PENDING_TTL_MS,
  TMP_STALE_MS,
  type IngestFn
} from '~/server/services/media-ingest-queue'
import * as schema from '~/server/db/schema'

const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ID3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PLENTY = 100 * 1024 ** 3

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

  function makeQueue(ingest: IngestFn, over: { freeBytes?: () => Promise<number> } = {}) {
    return createIngestQueue({
      db, store, ingest, log: () => {}, retryDelayMs: 0,
      freeBytes: over.freeBytes ?? (async () => PLENTY)
    })
  }

  async function insertJob(id: string, over: Partial<typeof schema.mediaUploads.$inferInsert> = {}) {
    const [row] = await db
      .insert(schema.mediaUploads)
      .values({
        id, filename: 'clip.mp4', kind: 'video', quality: 'standard', mimeType: 'video/mp4',
        bytes: 3, status: 'queued', ...over
      })
      .returning()
    return row
  }
  const stage = (id: string, text = 'abc') =>
    store.putStaged(id, Readable.from([Buffer.from(text)]), 'video/mp4')
  const job = async (id: string) =>
    (await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, id)).get())!
  async function insertMedia(sha = 'c'.repeat(64)) {
    const [m] = await db.insert(schema.media)
      .values({ sha256: sha, kind: 'video', filename: 'clip.mp4', bytes: 3 }).returning()
    return m
  }
  const permanent = (code: number, message: string) => Object.assign(new Error(message), { statusCode: code })

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
    const q = makeQueue(ingest)
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('done')
    expect(row.mediaId).toBe(media.id)
    expect(row.attempts).toBe(1)
    expect(row.error).toBeNull()
    expect(await store.statStaged(ID1)).toBeNull()
  })

  it('permanent ingest error (4xx) → failed immediately, staged object deleted', async () => {
    await insertJob(ID1)
    await stage(ID1)
    const ingest: IngestFn = vi.fn().mockRejectedValue(permanent(422, 'Could not process this video'))
    const q = makeQueue(ingest)
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('Could not process this video')
    expect(row.attempts).toBe(1)
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(await store.statStaged(ID1)).toBeNull()
  })

  it('retryable error keeps the staged object and retries until it succeeds', async () => {
    await insertJob(ID1)
    await stage(ID1)
    const media = await insertMedia()
    const ingest: IngestFn = vi.fn()
      .mockImplementationOnce(async () => {
        // Before this rejects, the staged object must still be intact —
        // asserted by the SECOND call below, which proves attempt 1 never
        // touched it (a retryable failure keeps the staged object).
        throw new Error('R2 connection reset')
      })
      .mockImplementationOnce(async (_db, _store, input) => {
        // Prove the bytes survived the first (retryable) failure: the fake
        // ingest never reads `input.stream`, so a queue bug that deleted the
        // staged object after attempt 1 would go undetected by a plain
        // "it eventually succeeds" assertion — this reads it back directly.
        expect(await store.statStaged(ID1)).toEqual({ bytes: 3 })
        const chunks: Buffer[] = []
        for await (const c of input.stream) chunks.push(c as Buffer)
        expect(Buffer.concat(chunks).toString()).toBe('abc')
        return media
      })
    const q = makeQueue(ingest)
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('done')
    expect(row.attempts).toBe(2)
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(await store.statStaged(ID1)).toBeNull()
  })

  it('gives up after MAX_ATTEMPTS retryable failures and then deletes the staged object', async () => {
    await insertJob(ID1)
    await stage(ID1)
    const ingest: IngestFn = vi.fn().mockRejectedValue(new Error('disk I/O error'))
    const q = makeQueue(ingest)
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.error).toMatch(/disk I\/O error/)
    expect(ingest).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(await store.statStaged(ID1)).toBeNull()
  })

  it('preflight: not enough free scratch space is retryable (staged kept, error recorded)', async () => {
    await insertJob(ID1, { bytes: 1024 ** 3 })
    await stage(ID1)
    const ingest = vi.fn()
    const q = makeQueue(ingest as IngestFn, { freeBytes: async () => 1024 ** 3 })
    q.enqueue(ID1)
    await q.idle()
    const row = await job(ID1)
    expect(row.status).toBe('failed') // exhausted MAX_ATTEMPTS with retryDelayMs 0
    expect(row.error).toMatch(/free disk space/i)
    expect(ingest).not.toHaveBeenCalled()
    expect(requiredScratchBytes(1024 ** 3)).toBe(2 * 1024 ** 3 + 256 * 1024 ** 2)
  })

  it('runs one job at a time, FIFO (explicit start signal, no sleeps)', async () => {
    await insertJob(ID1, { filename: 'one' })
    await insertJob(ID2, { filename: 'two' })
    await stage(ID1)
    await stage(ID2)
    const media = await insertMedia()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => (releaseFirst = r))
    let firstStarted!: () => void
    const started = new Promise<void>((r) => (firstStarted = r))
    const ingest: IngestFn = vi.fn(async (_db, _store, input) => {
      order.push(`start:${input.filename}`)
      if (input.filename === 'one') {
        firstStarted()
        await firstGate
      }
      order.push(`end:${input.filename}`)
      return media
    })
    const q = makeQueue(ingest)
    q.enqueue(ID1)
    q.enqueue(ID2)
    await started
    expect(order).toEqual(['start:one'])
    releaseFirst()
    await q.idle()
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
  })

  it('skips ids that are not queued (cancelled / unknown) and never double-claims', async () => {
    await insertJob(ID1, { status: 'pending' })
    const ingest = vi.fn()
    const q = makeQueue(ingest as IngestFn)
    q.enqueue(ID1)
    q.enqueue(ID1)
    q.enqueue('not-a-row')
    await q.idle()
    expect(ingest).not.toHaveBeenCalled()
    expect((await job(ID1)).status).toBe('pending')
  })

  it('reconcile(): enqueues queued rows and never touches processing rows', async () => {
    await insertJob(ID1, { status: 'processing', attempts: 1 })
    await insertJob(ID2, { status: 'queued' })
    await stage(ID2)
    const media = await insertMedia()
    const ingest: IngestFn = vi.fn().mockResolvedValue(media)
    const q = makeQueue(ingest)
    await q.reconcile()
    await q.idle()
    expect((await job(ID1)).status).toBe('processing') // a live transcode is left alone
    expect((await job(ID1)).attempts).toBe(1)
    expect((await job(ID2)).status).toBe('done')
    expect(ingest).toHaveBeenCalledTimes(1)
  })

  it('recover() (boot): processing rows are re-queued (or failed when exhausted); queued rows are enqueued', async () => {
    await insertJob(ID1, { status: 'processing', attempts: 1 })
    await insertJob(ID2, { status: 'processing', attempts: MAX_ATTEMPTS })
    await insertJob(ID3, { status: 'queued' })
    await stage(ID1)
    await stage(ID2)
    await stage(ID3)
    const media = await insertMedia()
    const ingest: IngestFn = vi.fn().mockResolvedValue(media)
    const q = makeQueue(ingest)
    await q.recover()
    await q.idle()
    expect((await job(ID1)).status).toBe('done')
    expect((await job(ID1)).attempts).toBe(2)
    expect((await job(ID2)).status).toBe('failed')
    expect((await job(ID2)).error).toMatch(/interrupted/i)
    expect(await store.statStaged(ID2)).toBeNull()
    expect((await job(ID3)).status).toBe('done')
    expect(ingest).toHaveBeenCalledTimes(2)
  })

  it('sweep() expires pending jobs older than 24h and deletes their staged objects', async () => {
    const now = Date.now()
    await insertJob(ID1, { status: 'pending', createdAt: new Date(now - PENDING_TTL_MS - 1000) })
    await insertJob(ID2, { status: 'pending', createdAt: new Date(now - 1000) })
    await stage(ID1)
    const q = makeQueue(vi.fn() as IngestFn)
    expect(await q.sweep(now)).toBe(1)
    expect((await job(ID1)).status).toBe('expired')
    expect(await store.statStaged(ID1)).toBeNull()
    expect((await job(ID2)).status).toBe('pending')
  })

  it('isPermanentIngestError: only 4xx h3 errors are permanent', () => {
    expect(isPermanentIngestError(permanent(422, 'x'))).toBe(true)
    expect(isPermanentIngestError(permanent(400, 'x'))).toBe(true)
    expect(isPermanentIngestError(permanent(500, 'x'))).toBe(false)
    expect(isPermanentIngestError(new Error('ECONNRESET'))).toBe(false)
    expect(isPermanentIngestError('nope')).toBe(false)
  })
})

describe('cleanupStaleTmp', () => {
  it('removes lanka-ingest-* dirs older than TMP_STALE_MS and keeps fresh/foreign ones', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lanka-tmpclean-'))
    try {
      const old = join(base, 'lanka-ingest-old')
      const fresh = join(base, 'lanka-ingest-fresh')
      const foreign = join(base, 'other-old')
      for (const d of [old, fresh, foreign]) mkdirSync(d)
      const now = Date.now()
      const stale = new Date(now - TMP_STALE_MS - 60_000)
      utimesSync(old, stale, stale)
      utimesSync(foreign, stale, stale)
      expect(await cleanupStaleTmp(now, base)).toBe(1)
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(foreign)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
