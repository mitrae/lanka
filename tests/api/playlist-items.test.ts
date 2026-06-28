import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
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
  afterEach(() => {
    try {
      db.run(sql`DROP TRIGGER IF EXISTS items_insert_fail`)
    } catch {}
    close()
  })

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

  it('rolls back the delete and version bump when the re-insert fails mid-transaction', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const v2 = await seedMedia(db, { sha256: 'v2', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: v.id }] })
    expect(pl.version).toBe(1)

    // Abort the re-insert so the (delete-all → insert → bump) sequence must
    // either fully apply or fully roll back. Without a wrapping transaction the
    // playlist would be left empty (devices then poll a blank manifest).
    db.run(sql`
      CREATE TRIGGER items_insert_fail
      BEFORE INSERT ON playlist_items
      FOR EACH ROW
      BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END
    `)

    await expect(
      handleReplacePlaylistItems(db, pl.id, { items: [{ mediaId: v2.id }] })
    ).rejects.toThrow(/simulated insert failure/)

    db.run(sql`DROP TRIGGER IF EXISTS items_insert_fail`)

    const items = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, pl.id))
    expect(items).toHaveLength(1)
    expect(items[0].mediaId).toBe(v.id)

    const [refreshed] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(refreshed.version).toBe(1)
  })
})
