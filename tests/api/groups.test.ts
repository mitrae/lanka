import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedPlaylist
} from '../helpers/fixtures'
import {
  handleListGroups,
  handleCreateGroup
} from '~/server/api/groups/index.post'
import {
  handleGetGroup,
  handleUpdateGroup,
  handleDeleteGroup
} from '~/server/api/groups/[id].delete'
import * as schema from '~/server/db/schema'

describe('groups CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns all groups when no filter', async () => {
    const a = await seedAddress(db, 'A')
    const b = await seedAddress(db, 'B')
    await seedGroup(db, a.id, 'Ga')
    await seedGroup(db, b.id, 'Gb')
    const rows = await handleListGroups(db, {})
    expect(rows).toHaveLength(2)
  })

  it('list filters by addressId', async () => {
    const a = await seedAddress(db, 'A')
    const b = await seedAddress(db, 'B')
    await seedGroup(db, a.id, 'Ga')
    await seedGroup(db, b.id, 'Gb')
    const rows = await handleListGroups(db, { addressId: a.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Ga')
  })

  it('create requires addressId + name', async () => {
    const a = await seedAddress(db)
    const row = await handleCreateGroup(db, { addressId: a.id, name: 'Lobby' })
    expect(row.name).toBe('Lobby')
    expect(row.addressId).toBe(a.id)
  })

  it('create 400s on invalid addressId FK', async () => {
    await expect(
      handleCreateGroup(db, { addressId: 9999, name: 'G' })
    ).rejects.toThrow()
  })

  it('get returns the row', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'G')
    const row = await handleGetGroup(db, g.id)
    expect(row.name).toBe('G')
  })

  it('get 404s on unknown', async () => {
    await expect(handleGetGroup(db, 9999)).rejects.toThrow(/not found/i)
  })

  it('get returns no assignment when nothing is assigned', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'G')
    const row = await handleGetGroup(db, g.id)
    expect(row.directPlaylistId).toBeNull()
    expect(row.directPlaylistName).toBeNull()
    expect(row.effectivePlaylistId).toBeNull()
    expect(row.effectiveLevel).toBeNull()
  })

  it('get returns the direct group-level assignment', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'G')
    const pl = await seedPlaylist(db, { name: 'Lobby loop' })
    await assign(db, { playlistId: pl.id, groupId: g.id })

    const row = await handleGetGroup(db, g.id)
    expect(row.directPlaylistId).toBe(pl.id)
    expect(row.directPlaylistName).toBe('Lobby loop')
    expect(row.effectivePlaylistId).toBe(pl.id)
    expect(row.effectivePlaylistName).toBe('Lobby loop')
    expect(row.effectiveLevel).toBe('group')
  })

  it('get reports the inherited address assignment', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'G')
    const pl = await seedPlaylist(db, { name: 'Clinic default' })
    await assign(db, { playlistId: pl.id, addressId: a.id })

    const row = await handleGetGroup(db, g.id)
    expect(row.directPlaylistId).toBeNull()
    expect(row.effectivePlaylistId).toBe(pl.id)
    expect(row.effectivePlaylistName).toBe('Clinic default')
    expect(row.effectiveLevel).toBe('address')
  })

  it('get prefers the group assignment over the address one', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'G')
    const addrPl = await seedPlaylist(db, { name: 'Clinic default' })
    const grpPl = await seedPlaylist(db, { name: 'Lobby loop' })
    await assign(db, { playlistId: addrPl.id, addressId: a.id })
    await assign(db, { playlistId: grpPl.id, groupId: g.id })

    const row = await handleGetGroup(db, g.id)
    expect(row.directPlaylistId).toBe(grpPl.id)
    expect(row.effectivePlaylistId).toBe(grpPl.id)
    expect(row.effectiveLevel).toBe('group')
  })

  it('update changes name', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id, 'Before')
    const updated = await handleUpdateGroup(db, g.id, { name: 'After' })
    expect(updated.name).toBe('After')
  })

  it('update can move group to another address', async () => {
    const a = await seedAddress(db, 'A')
    const b = await seedAddress(db, 'B')
    const g = await seedGroup(db, a.id, 'G')
    const updated = await handleUpdateGroup(db, g.id, { addressId: b.id })
    expect(updated.addressId).toBe(b.id)
  })

  it('delete sets devices.group_id to null', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'dev-1', groupId: g.id })
    await handleDeleteGroup(db, g.id)

    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    expect(dev.groupId).toBeNull()
  })
})
