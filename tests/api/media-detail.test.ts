import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { handleListMedia } from '~/server/api/media/index.get'
import { handleGetMedia } from '~/server/api/media/[id].get'
import * as schema from '~/server/db/schema'

describe('media list + detail enrichment', () => {
  let db: TestDb, close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('list returns organizationId and playCount', async () => {
    const [org] = await db.insert(schema.organizations).values({ name: 'Acme' }).returning()
    const m = await seedMedia(db, { sha256: 's1', kind: 'image', filename: 'a.jpg' })
    await db.update(schema.media).set({ organizationId: org.id, playCount: 3 }).where(eq(schema.media.id, m.id))
    const rows = await handleListMedia(db)
    const row = rows.find((r) => r.id === m.id)!
    expect(row.organizationId).toBe(org.id)
    expect(row.playCount).toBe(3)
  })

  it('detail returns playlists-used, organizationId, playCount', async () => {
    const m = await seedMedia(db, { sha256: 's2', kind: 'video', filename: 'b.mp4' })
    const pl = await seedPlaylist(db, { name: 'P1', items: [{ mediaId: m.id }] })
    const detail = await handleGetMedia(db, m.id)
    expect(detail.playCount).toBe(0)
    expect(detail.organizationId).toBeNull()
    expect(detail.playlists).toEqual([{ id: pl.id, name: 'P1' }])
  })

  it('detail 404s on unknown id', async () => {
    await expect(handleGetMedia(db, 9999)).rejects.toMatchObject({ statusCode: 404 })
  })
})
