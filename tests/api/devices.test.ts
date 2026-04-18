import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedDevice, seedGroup } from '../helpers/fixtures'
import { handleListDevices } from '~/server/api/devices/index.get'
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

  it('list excludes unclaimed by default, includes when ?unclaimed=true', async () => {
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
})
