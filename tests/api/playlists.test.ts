import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedGroup,
  seedMedia,
  seedPlaylist
} from '../helpers/fixtures'
import {
  handleListPlaylists,
  handleCreatePlaylist
} from '~/server/api/playlists/index.post'
import {
  handleGetPlaylist,
  handleUpdatePlaylist,
  handleDeletePlaylist
} from '~/server/api/playlists/[id].delete'
import * as schema from '~/server/db/schema'

describe('playlists CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns summary with itemCount and assignmentCount', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, {
      name: 'p',
      items: [{ mediaId: m.id }, { mediaId: m.id }]
    })
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await assign(db, { playlistId: pl.id, groupId: g.id })

    const rows = await handleListPlaylists(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('p')
    expect(rows[0].itemCount).toBe(2)
    expect(rows[0].assignmentCount).toBe(1)
  })

  it('create inserts with version 1', async () => {
    const row = await handleCreatePlaylist(db, { name: 'New' })
    expect(row.name).toBe('New')
    expect(row.version).toBe(1)
  })

  it('get returns single row with items included', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'image' })
    const pl = await seedPlaylist(db, {
      name: 'p',
      items: [{ mediaId: m.id, durationMsOverride: 5000 }]
    })

    const row = await handleGetPlaylist(db, pl.id)
    expect(row.items).toHaveLength(1)
    expect(row.items[0].mediaId).toBe(m.id)
    expect(row.items[0].durationMsOverride).toBe(5000)
  })

  it('update renames and bumps version', async () => {
    const pl = await seedPlaylist(db, { name: 'Old' })
    const updated = await handleUpdatePlaylist(db, pl.id, { name: 'New' })
    expect(updated.name).toBe('New')
    expect(updated.version).toBe(2)
  })

  it('delete cascades to playlist_items', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    await handleDeletePlaylist(db, pl.id)

    expect(await db.select().from(schema.playlists)).toHaveLength(0)
    expect(await db.select().from(schema.playlistItems)).toHaveLength(0)
  })
})
