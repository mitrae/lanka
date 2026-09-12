import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia } from '../helpers/fixtures'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

const noopStore = {
  put: async () => {},
  open: async () => { throw new Error('unused') },
  openThumbnail: async () => { throw new Error('unused') },
  putThumbnail: async () => {},
  delete: async () => {},
  deleteThumbnail: async () => {},
  exists: async () => false
} as any

describe('deleting the interrupt clip', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  async function configure(mediaId: number) {
    await db.insert(schema.interrupts).values({
      id: 1, mediaId, atMinutes: 540, timezone: 'Europe/Kyiv', enabled: true
    })
  }

  it('409s rather than leaving a schedule that silently never plays', async () => {
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    await configure(clip.id)
    await expect(
      handleDeleteMedia(db, noopStore, clip.id, { force: false })
    ).rejects.toMatchObject({ statusCode: 409 })
    const still = await db.select().from(schema.media).where(eq(schema.media.id, clip.id))
    expect(still).toHaveLength(1)
  })

  it('the playlist force flag alone does NOT clear the schedule — that confirm never mentioned it', async () => {
    // The media page escalates to force=true whenever the clip is in a
    // playlist. If that also bypassed this guard, the daily schedule would be
    // deleted as a side effect of a dialog about playlists.
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    await configure(clip.id)
    await expect(
      handleDeleteMedia(db, noopStore, clip.id, { force: true })
    ).rejects.toMatchObject({ statusCode: 409 })
    const rows = await db.select().from(schema.interrupts)
    expect(rows).toHaveLength(1)
  })

  it('clearInterrupt deletes the interrupt row in the same transaction', async () => {
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    await configure(clip.id)
    await handleDeleteMedia(db, noopStore, clip.id, { force: false, clearInterrupt: true })

    const media = await db.select().from(schema.media).where(eq(schema.media.id, clip.id))
    expect(media).toHaveLength(0)
    const rows = await db.select().from(schema.interrupts)
    expect(rows).toHaveLength(0)
  })

  it('leaves unrelated media alone', async () => {
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    const other = await seedMedia(db, { sha256: 'other', kind: 'video', durationMs: 5000 })
    await configure(clip.id)
    await handleDeleteMedia(db, noopStore, other.id, { force: false, clearInterrupt: false })
    const rows = await db.select().from(schema.interrupts)
    expect(rows).toHaveLength(1)
  })
})
