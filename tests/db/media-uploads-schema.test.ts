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
