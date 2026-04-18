// tests/services/resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedMedia,
  seedPlaylist
} from '../helpers/fixtures'
import { resolvePlaylistForDevice } from '~/server/services/resolver'

describe('resolvePlaylistForDevice', () => {
  let db: TestDb
  let close: () => void

  beforeEach(async () => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })

  afterEach(() => close())

  it('returns null when no assignment matches', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })

    const result = await resolvePlaylistForDevice(db, 'dev-1')
    expect(result).toBeNull()
  })

  it('resolves to the device-level assignment', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'abc', kind: 'video' })
    const pl = await seedPlaylist(db, { name: 'direct', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: pl.id, level: 'device' })
  })

  it('falls back to group-level when device has none', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { name: 'group', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, groupId: group.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: pl.id, level: 'group' })
  })

  it('falls back to address-level when device and group have none', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { name: 'address', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, addressId: addr.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: pl.id, level: 'address' })
  })

  it('device-level beats group-level when both assigned', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const devPl = await seedPlaylist(db, { name: 'dev', items: [{ mediaId: m.id }] })
    const grpPl = await seedPlaylist(db, { name: 'grp', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: devPl.id, deviceId: 'dev-1' })
    await assign(db, { playlistId: grpPl.id, groupId: group.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: devPl.id, level: 'device' })
  })

  it('group-level beats address-level when both assigned', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const grpPl = await seedPlaylist(db, { name: 'grp', items: [{ mediaId: m.id }] })
    const addrPl = await seedPlaylist(db, { name: 'addr', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: grpPl.id, groupId: group.id })
    await assign(db, { playlistId: addrPl.id, addressId: addr.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: grpPl.id, level: 'group' })
  })

  it('returns null for unknown device id', async () => {
    const r = await resolvePlaylistForDevice(db, 'does-not-exist')
    expect(r).toBeNull()
  })

  it('returns null for unclaimed device (group_id is null)', async () => {
    await seedDevice(db, { id: 'dev-1' })
    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toBeNull()
  })
})
