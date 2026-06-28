import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { ingestMedia } from '~/server/api/media.post'
import * as schema from '~/server/db/schema'

describe('ingestMedia', () => {
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

  function readable(text: string) {
    return Readable.from([Buffer.from(text)])
  }

  it('stores a new image and creates a media row', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('PNG-BYTES'),
      filename: 'test.png',
      kind: 'image'
    })
    expect(row.sha256).toBe(
      '71a5d2aaa19f4e61586b93e1b533793bf0c49cdb8ccb4f89043d3229ef8f9db8'
    )
    expect(row.kind).toBe('image')
    expect(row.filename).toBe('test.png')
    expect(row.bytes).toBe(9)
    expect(row.sourceSha256).toBe(row.sha256) // images: source === stored
    expect(await store.has(row.sha256)).toBe(true)
  })

  it('dedupes — second upload of same content returns the existing row', async () => {
    const a = await ingestMedia(db, store, {
      stream: readable('SAME'),
      filename: 'a.png',
      kind: 'image'
    })
    const b = await ingestMedia(db, store, {
      stream: readable('SAME'),
      filename: 'b.png',
      kind: 'image'
    })
    expect(b.id).toBe(a.id)
    expect(b.filename).toBe('a.png') // original filename preserved

    const all = await db.select().from(schema.media)
    expect(all).toHaveLength(1)
  })

  it('records duration_ms when given for images', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('ANIMATED-GIF'),
      filename: 'clip.gif',
      kind: 'image',
      durationMs: 15000
    })
    expect(row.durationMs).toBe(15000)
  })

  it('rejects empty streams', async () => {
    await expect(
      ingestMedia(db, store, {
        stream: Readable.from([]),
        filename: 'empty.bin',
        kind: 'image'
      })
    ).rejects.toThrow(/empty/i)
  })

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

  it('defaults quality to standard', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('PNG-BYTES'),
      filename: 'test.png',
      kind: 'image'
    })
    expect(row.quality).toBe('standard')
  })

  it('stores a thumbnail for image uploads', async () => {
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
})
