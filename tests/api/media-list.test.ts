import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleListMedia } from '~/server/api/media/index.get'
import { handleGetMedia } from '~/server/api/media/[id].get'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

describe('media CRUD beyond upload', () => {
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

  it('list returns all media with usedInPlaylists count', async () => {
    const a = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const b = await seedMedia(db, { sha256: 'b', kind: 'image' })
    await seedPlaylist(db, { items: [{ mediaId: a.id }] })
    await seedPlaylist(db, { items: [{ mediaId: a.id }, { mediaId: b.id }] })

    const rows = await handleListMedia(db)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(a.id)!.usedInPlaylists).toBe(2)
    expect(byId.get(b.id)!.usedInPlaylists).toBe(1)
  })

  it('list rows include the quality field', async () => {
    await seedMedia(db, { sha256: 'q1', kind: 'video' })
    const rows = await handleListMedia(db)
    expect(rows[0]).toHaveProperty('quality')
    expect(rows[0].quality).toBe('standard') // default quality
  })

  it('get returns the row', async () => {
    const m = await seedMedia(db, { sha256: 'x', kind: 'image' })
    const row = await handleGetMedia(db, m.id)
    expect(row.sha256).toBe('x')
  })

  it('get 404s on unknown', async () => {
    await expect(handleGetMedia(db, 9999)).rejects.toThrow(/not found/i)
  })

  it('delete removes media + files when not referenced', async () => {
    const m = await seedMedia(db, { sha256: 'lone', kind: 'image' })
    await store.put('lone', Readable.from([Buffer.from('data')]))
    await store.putThumbnail('lone', Readable.from([Buffer.from('thumb')]))

    await handleDeleteMedia(db, store, m.id, { force: false })

    expect(await db.select().from(schema.media)).toHaveLength(0)
    expect(await store.has('lone')).toBe(false)
    expect(await store.hasThumbnail('lone')).toBe(false)
  })

  it('delete 409s when media is referenced by a playlist_item', async () => {
    const m = await seedMedia(db, { sha256: 'used', kind: 'image' })
    await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    await expect(
      handleDeleteMedia(db, store, m.id, { force: false })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('delete force=true removes referenced media and bumps playlist versions', async () => {
    const m = await seedMedia(db, { sha256: 'force', kind: 'image' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    expect(pl.version).toBe(1)

    await handleDeleteMedia(db, store, m.id, { force: true })

    expect(await db.select().from(schema.media)).toHaveLength(0)
    const [updatedPl] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(updatedPl.version).toBe(2) // bumped
  })

  it('delete 404s on unknown id', async () => {
    await expect(
      handleDeleteMedia(db, store, 9999, { force: false })
    ).rejects.toThrow(/not found/i)
  })
})
