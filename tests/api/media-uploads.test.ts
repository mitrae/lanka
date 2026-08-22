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
import { handleCompleteUpload } from '~/server/api/media/uploads/[id]/complete.post'
import { handleReceiveUploadFile } from '~/server/api/media/uploads/[id]/file.put'
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

    it('caps the filename at 255 characters (code points, not UTF-16 units)', async () => {
      const res = await handleCreateUpload(db, store, { ...valid, filename: 'x'.repeat(300) }, { maxBytes: MAX })
      expect(res.filename).toHaveLength(255)
      const emoji = await handleCreateUpload(db, store, { ...valid, filename: '😀'.repeat(300) }, { maxBytes: MAX })
      expect(Array.from(emoji.filename)).toHaveLength(255)
    })

    it('does not leave a row behind when presigning fails', async () => {
      const broken = Object.assign(Object.create(store), {
        createStagedUpload: async () => { throw new Error('presign exploded') }
      })
      await expect(handleCreateUpload(db, broken, valid, { maxBytes: MAX })).rejects.toThrow('presign exploded')
      expect(await db.select().from(schema.mediaUploads)).toHaveLength(0)
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

    it('two concurrent cancels: exactly one succeeds, the other 404s', async () => {
      await seed(A, 'pending')
      const results = await Promise.allSettled([handleCancelUpload(db, store, A), handleCancelUpload(db, store, A)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(failed.reason.statusCode).toBe(404)
    })
  })

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
      // body shorter than declared (client disconnected) → error, nothing staged
      await expect(
        handleReceiveUploadFile(db, store, A, Readable.from([Buffer.from('ab')]), 3, { maxBytes: MAX })
      ).rejects.toThrow(/declared/)
      expect(await store.statStaged(A)).toBeNull()
      await db.update(schema.mediaUploads).set({ status: 'queued' }).where(eq(schema.mediaUploads.id, A))
      await expect(handleReceiveUploadFile(db, store, A, body(), 3, { maxBytes: MAX })).rejects.toMatchObject({ statusCode: 409 })
    })

    it('handleCompleteUpload verifies the staged size, queues, enqueues once, and is idempotent', async () => {
      await seedPending(3)
      await store.putStaged(A, Readable.from([Buffer.from('abc')]), 'image/png')
      const enqueue = vi.fn()
      const job = await handleCompleteUpload(db, store, { enqueue }, A)
      expect(job.status).toBe('queued')
      expect(enqueue).toHaveBeenCalledWith(A)
      // repeat (lost response, client retry): same job back, no second enqueue
      const again = await handleCompleteUpload(db, store, { enqueue }, A)
      expect(again.status).toBe('queued')
      expect(enqueue).toHaveBeenCalledTimes(1)
      await db.update(schema.mediaUploads).set({ status: 'failed' }).where(eq(schema.mediaUploads.id, A))
      await expect(handleCompleteUpload(db, store, { enqueue }, A)).rejects.toMatchObject({ statusCode: 409 })
    })

    it('two concurrent completes enqueue exactly once', async () => {
      await seedPending(3)
      await store.putStaged(A, Readable.from([Buffer.from('abc')]), 'image/png')
      const enqueue = vi.fn()
      const results = await Promise.allSettled([
        handleCompleteUpload(db, store, { enqueue }, A),
        handleCompleteUpload(db, store, { enqueue }, A)
      ])
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect((await jobRow()).status).toBe('queued')
    })

    it('complete vs cancel race: one wins, the other fails cleanly, no enqueue of a deleted row', async () => {
      await seedPending(3)
      await store.putStaged(A, Readable.from([Buffer.from('abc')]), 'image/png')
      const enqueue = vi.fn()
      const [c, d] = await Promise.allSettled([
        handleCompleteUpload(db, store, { enqueue }, A),
        handleCancelUpload(db, store, A)
      ])
      const row = await db.select().from(schema.mediaUploads).where(eq(schema.mediaUploads.id, A)).get()
      if (c.status === 'fulfilled') {
        expect(d.status).toBe('rejected')
        expect(row?.status).toBe('queued')
        expect(enqueue).toHaveBeenCalledTimes(1)
      } else {
        expect(d.status).toBe('fulfilled')
        expect(row).toBeUndefined()
        expect(enqueue).not.toHaveBeenCalled()
        expect((c as PromiseRejectedResult).reason.statusCode).toBe(404)
      }
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
})
