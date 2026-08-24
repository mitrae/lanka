import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedPlaylist
} from '../helpers/fixtures'
import { handleListDevices } from '~/server/api/devices/index.get'
import { handleRegister } from '~/server/api/devices/register.post'
import { handleTelemetry } from '~/server/api/devices/[id]/telemetry.post'
import {
  handleGetDevice,
  handleUpdateDevice,
  handleDeleteDevice
} from '~/server/api/devices/[id].delete'
import * as schema from '~/server/db/schema'

describe('devices CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns all devices with computed status', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await db
      .insert(schema.devices)
      .values({ id: 'online', groupId: g.id, lastSeenAt: new Date() })
    await db
      .insert(schema.devices)
      .values({
        id: 'idle',
        groupId: g.id,
        lastSeenAt: new Date(Date.now() - 3 * 60 * 1000)
      })
    await db
      .insert(schema.devices)
      .values({
        id: 'offline',
        groupId: g.id,
        lastSeenAt: new Date(Date.now() - 10 * 60 * 1000)
      })
    await db.insert(schema.devices).values({ id: 'never' })

    const rows = await handleListDevices(db, {})
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('online')!.status).toBe('online')
    expect(byId.get('idle')!.status).toBe('idle')
    expect(byId.get('offline')!.status).toBe('offline')
    expect(byId.get('never')!.status).toBe('offline')
  })

  it('list filters by groupId', async () => {
    const a = await seedAddress(db)
    const g1 = await seedGroup(db, a.id, 'G1')
    const g2 = await seedGroup(db, a.id, 'G2')
    await seedDevice(db, { id: 'in-g1', groupId: g1.id })
    await seedDevice(db, { id: 'in-g2', groupId: g2.id })

    const rows = await handleListDevices(db, { groupId: g1.id })
    expect(rows.map((r) => r.id)).toEqual(['in-g1'])
  })

  it('list filters by addressId (joins groups)', async () => {
    const a1 = await seedAddress(db, 'A1')
    const a2 = await seedAddress(db, 'A2')
    const g1 = await seedGroup(db, a1.id)
    const g2 = await seedGroup(db, a2.id)
    await seedDevice(db, { id: 'a1-d', groupId: g1.id })
    await seedDevice(db, { id: 'a2-d', groupId: g2.id })

    const rows = await handleListDevices(db, { addressId: a1.id })
    expect(rows.map((r) => r.id)).toEqual(['a1-d'])
  })

  it('list includes claimed + unclaimed by default; ?unclaimed=true narrows to unclaimed only', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'unclaimed' })
    await seedDevice(db, { id: 'claimed', groupId: g.id })

    const both = await handleListDevices(db, {})
    expect(both.map((r) => r.id).sort()).toEqual(['claimed', 'unclaimed'])

    const onlyUnclaimed = await handleListDevices(db, { unclaimed: true })
    expect(onlyUnclaimed.map((r) => r.id)).toEqual(['unclaimed'])
  })

  it('get returns the device', async () => {
    await seedDevice(db, { id: 'd', name: 'TV' })
    const row = await handleGetDevice(db, 'd')
    expect(row.name).toBe('TV')
  })

  it('get 404s on unknown', async () => {
    await expect(handleGetDevice(db, 'ghost')).rejects.toThrow(/not found/i)
  })

  it('get returns no assignment when nothing is assigned', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id })
    const row = await handleGetDevice(db, 'd')
    expect(row.directPlaylistId).toBeNull()
    expect(row.directPlaylistName).toBeNull()
    expect(row.effectivePlaylistId).toBeNull()
    expect(row.effectivePlaylistName).toBeNull()
    expect(row.effectiveLevel).toBeNull()
  })

  it('get returns the direct device-level assignment', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id })
    const pl = await seedPlaylist(db, { name: 'Amosova' })
    await assign(db, { playlistId: pl.id, deviceId: 'd' })

    const row = await handleGetDevice(db, 'd')
    expect(row.directPlaylistId).toBe(pl.id)
    expect(row.directPlaylistName).toBe('Amosova')
    expect(row.effectivePlaylistId).toBe(pl.id)
    expect(row.effectivePlaylistName).toBe('Amosova')
    expect(row.effectiveLevel).toBe('device')
  })

  it('get reports an inherited group assignment with no direct override', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id })
    const pl = await seedPlaylist(db, { name: 'Lobby loop' })
    await assign(db, { playlistId: pl.id, groupId: g.id })

    const row = await handleGetDevice(db, 'd')
    expect(row.directPlaylistId).toBeNull()
    expect(row.directPlaylistName).toBeNull()
    expect(row.effectivePlaylistId).toBe(pl.id)
    expect(row.effectivePlaylistName).toBe('Lobby loop')
    expect(row.effectiveLevel).toBe('group')
  })

  it('get reports an inherited address assignment', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id })
    const pl = await seedPlaylist(db, { name: 'Clinic default' })
    await assign(db, { playlistId: pl.id, addressId: a.id })

    const row = await handleGetDevice(db, 'd')
    expect(row.directPlaylistId).toBeNull()
    expect(row.effectivePlaylistId).toBe(pl.id)
    expect(row.effectivePlaylistName).toBe('Clinic default')
    expect(row.effectiveLevel).toBe('address')
  })

  it('get prefers the direct assignment over an inherited one', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id })
    const inherited = await seedPlaylist(db, { name: 'Lobby loop' })
    const direct = await seedPlaylist(db, { name: 'Amosova' })
    await assign(db, { playlistId: inherited.id, groupId: g.id })
    await assign(db, { playlistId: direct.id, deviceId: 'd' })

    const row = await handleGetDevice(db, 'd')
    expect(row.directPlaylistId).toBe(direct.id)
    expect(row.effectivePlaylistId).toBe(direct.id)
    expect(row.effectiveLevel).toBe('device')
  })

  it('update renames', async () => {
    await seedDevice(db, { id: 'd', name: 'Old' })
    const updated = await handleUpdateDevice(db, 'd', { name: 'New' })
    expect(updated.name).toBe('New')
  })

  it('update claims unclaimed device (groupId)', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd' })
    const updated = await handleUpdateDevice(db, 'd', {
      groupId: g.id,
      name: 'TV-1'
    })
    expect(updated.groupId).toBe(g.id)
    expect(updated.name).toBe('TV-1')
  })

  it('update with groupId: null unclaims', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await seedDevice(db, { id: 'd', groupId: g.id, name: 'TV' })
    const updated = await handleUpdateDevice(db, 'd', { groupId: null })
    expect(updated.groupId).toBeNull()
  })

  it('delete removes the row', async () => {
    await seedDevice(db, { id: 'd' })
    await handleDeleteDevice(db, 'd')
    expect(await db.select().from(schema.devices)).toHaveLength(0)
  })

  it('listed device includes surface; freshly-registered device defaults to webview', async () => {
    const a = await seedAddress(db)
    const g = await seedGroup(db, a.id)
    await handleRegister(db, { deviceId: 'dev-list-surface', playerVersion: '0.1.0' })
    // claim it so it can be listed by addressId (exercises the explicit-column branch)
    await db.update(schema.devices).set({ groupId: g.id }).where(
      (await import('drizzle-orm')).eq(schema.devices.id, 'dev-list-surface')
    )
    const rows = await handleListDevices(db, { addressId: a.id })
    const row = rows.find(r => r.id === 'dev-list-surface')
    expect(row).toBeDefined()
    expect(row!.surface).toBe('webview')
  })

  it('the device list carries visibility per row', async () => {
    await seedDevice(db, { id: 'dev-vis' })
    await handleTelemetry(db, 'dev-vis', { visibility: 'background', foregroundPackage: 'com.x' })
    const rows = await handleListDevices(db, {})
    const row = rows.find((r) => r.id === 'dev-vis')!
    expect(row.visibility).toBe('background')
    expect(row.foregroundPackage).toBe('com.x')
  })

  it('the address-filtered list carries visibility too', async () => {
    // This branch uses an EXPLICIT column projection rather than select(), so a
    // new column is silently dropped here unless it is added by hand.
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-addr', groupId: grp.id })
    await handleTelemetry(db, 'dev-addr', {
      visibility: 'obscured',
      foregroundPackage: 'com.android.settings',
      snapBacks: 3
    })
    const rows = await handleListDevices(db, { addressId: addr.id })
    const row = rows.find((r) => r.id === 'dev-addr')!
    expect(row.visibility).toBe('obscured')
    expect(row.foregroundPackage).toBe('com.android.settings')
    expect(row.snapBacks).toBe(3)
  })
})
