// tests/services/thumbnail-repair.test.ts
//
// Guards the invariant the 2026-09-06 transcode backfill broke on prod:
// `media.thumbnail_bytes != null` MUST mean `thumbs/<sha256>.jpg` exists in the
// store, because MediaCard renders an <img> off the column and the route 404s
// off the object. A row that claims a thumbnail it does not have renders as a
// broken image, permanently.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/test-db'
import * as schema from '~/server/db/schema'
import { LocalDiskStore } from '~/server/services/media-store'
import { repairMissingThumbnails } from '~/server/services/thumbnail-repair'

async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 0, g: 128, b: 255 } }
  })
    .png()
    .toBuffer()
}

describe('repairMissingThumbnails', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-thumb-repair-'))
    store = new LocalDiskStore(dir)
  })

  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function insertMedia(sha: string, thumbnailBytes: number | null) {
    const [row] = await db
      .insert(schema.media)
      .values({
        sha256: sha,
        kind: 'image',
        filename: 'pic.png',
        mimeType: 'image/png',
        bytes: 1,
        thumbnailBytes
      })
      .returning()
    return row
  }

  it('regenerates a thumbnail the store is missing and rewrites thumbnailBytes', async () => {
    const sha = 'a'.repeat(64)
    await store.put(sha, Readable.from([await pngBytes()]))
    const row = await insertMedia(sha, 5921) // stale count from the old sha

    const res = await repairMissingThumbnails(db, store)

    expect(res.repaired).toBe(1)
    expect(res.failed).toBe(0)
    expect(await store.hasThumbnail(sha)).toBe(true)

    const [after] = await db.select().from(schema.media).where(eq(schema.media.id, row.id))
    const chunks: Buffer[] = []
    for await (const c of await store.openThumbnail(sha)) chunks.push(c as Buffer)
    expect(after.thumbnailBytes).toBe(Buffer.concat(chunks).length)
    expect(after.thumbnailBytes).not.toBe(5921)
  })

  it('leaves a row whose thumbnail is present untouched', async () => {
    const sha = 'b'.repeat(64)
    await store.put(sha, Readable.from([await pngBytes()]))
    await store.putThumbnail(sha, Readable.from([Buffer.from('existing-thumb')]))
    const row = await insertMedia(sha, 14)

    const res = await repairMissingThumbnails(db, store)

    expect(res.ok).toBe(1)
    expect(res.repaired).toBe(0)
    const [after] = await db.select().from(schema.media).where(eq(schema.media.id, row.id))
    expect(after.thumbnailBytes).toBe(14)
  })

  it('nulls thumbnailBytes when the thumbnail cannot be regenerated', async () => {
    // No <img> is better than a broken one: a null column renders the icon.
    const sha = 'c'.repeat(64)
    await store.put(sha, Readable.from([Buffer.from('not an image')]))
    const row = await insertMedia(sha, 4028)

    const res = await repairMissingThumbnails(db, store)

    expect(res.failed).toBe(1)
    const [after] = await db.select().from(schema.media).where(eq(schema.media.id, row.id))
    expect(after.thumbnailBytes).toBeNull()
  })

  it('dryRun reports the work without writing anything', async () => {
    const sha = 'd'.repeat(64)
    await store.put(sha, Readable.from([await pngBytes()]))
    const row = await insertMedia(sha, 5921)

    const res = await repairMissingThumbnails(db, store, { dryRun: true })

    expect(res.repaired).toBe(1)
    expect(await store.hasThumbnail(sha)).toBe(false)
    const [after] = await db.select().from(schema.media).where(eq(schema.media.id, row.id))
    expect(after.thumbnailBytes).toBe(5921)
  })

  it('skips a row whose media object is gone from the store', async () => {
    const sha = 'e'.repeat(64)
    const row = await insertMedia(sha, 1234)

    const res = await repairMissingThumbnails(db, store)

    expect(res.failed).toBe(1)
    const [after] = await db.select().from(schema.media).where(eq(schema.media.id, row.id))
    expect(after.thumbnailBytes).toBeNull()
  })
})
