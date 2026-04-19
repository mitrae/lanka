import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

describe('handleDeleteMedia force=true is atomic', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-tx-'))
    store = new LocalDiskStore(dir)
  })

  afterEach(() => {
    try {
      db.run(sql`DROP TRIGGER IF EXISTS media_delete_fail`)
    } catch {}
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rolls back when the media delete fails mid-transaction', async () => {
    const m = await seedMedia(db, { sha256: 'tx', kind: 'image' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    expect(pl.version).toBe(1)

    db.run(sql`
      CREATE TRIGGER media_delete_fail
      BEFORE DELETE ON media
      FOR EACH ROW
      BEGIN SELECT RAISE(ABORT, 'simulated media delete failure'); END
    `)

    await expect(
      handleDeleteMedia(db, store, m.id, { force: true })
    ).rejects.toThrow(/simulated media delete failure/)

    db.run(sql`DROP TRIGGER IF EXISTS media_delete_fail`)

    const items = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.mediaId, m.id))
    expect(items).toHaveLength(1)

    const [rowPl] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(rowPl.version).toBe(1)

    const mrows = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, m.id))
    expect(mrows).toHaveLength(1)
  })
})
