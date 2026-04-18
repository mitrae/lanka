// tests/services/playlist-version.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedPlaylist } from '../helpers/fixtures'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'
import * as schema from '~/server/db/schema'

describe('bumpPlaylistVersion', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('increments version by one', async () => {
    const pl = await seedPlaylist(db, { name: 'x' })
    expect(pl.version).toBe(1)

    await bumpPlaylistVersion(db, pl.id)
    const [after] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))

    expect(after.version).toBe(2)
  })

  it('increments repeatedly', async () => {
    const pl = await seedPlaylist(db)
    await bumpPlaylistVersion(db, pl.id)
    await bumpPlaylistVersion(db, pl.id)
    await bumpPlaylistVersion(db, pl.id)
    const [after] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(after.version).toBe(4)
  })

  it('updates updatedAt', async () => {
    const pl = await seedPlaylist(db)
    const before = pl.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    await bumpPlaylistVersion(db, pl.id)
    const [after] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('throws if playlist does not exist', async () => {
    await expect(bumpPlaylistVersion(db, 9999)).rejects.toThrow()
  })
})
