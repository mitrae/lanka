import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedDevice, seedGroup, seedMedia, seedPlaylist } from '../helpers/fixtures'
import { EventsHub } from '~/server/services/events'
import {
  handleAssignDevice,
  handleUnassignDevice
} from '~/server/api/assignments/devices/[id].delete'
import {
  handleAssignGroup,
  handleUnassignGroup
} from '~/server/api/assignments/groups/[id].delete'
import {
  handleAssignAddress,
  handleUnassignAddress
} from '~/server/api/assignments/addresses/[id].delete'
import * as schema from '~/server/db/schema'

describe('assignments', () => {
  let db: TestDb
  let close: () => void
  let hub: EventsHub

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new EventsHub()
  })
  afterEach(() => close())

  async function setupTree() {
    const a = await seedAddress(db, 'A')
    const g = await seedGroup(db, a.id, 'G')
    await seedDevice(db, { id: 'd1', groupId: g.id })
    await seedDevice(db, { id: 'd2', groupId: g.id })
    const m = await seedMedia(db, { sha256: 'm', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    return { a, g, pl }
  }

  it('device-level assign creates the row and kicks that device', async () => {
    const { pl } = await setupTree()
    const received: string[] = []
    hub.subscribeDevice('d1', (e) => received.push(e))
    hub.subscribeDevice('d2', (e) => received.push(e))

    await handleAssignDevice(db, hub, 'd1', { playlistId: pl.id })

    const rows = await db.select().from(schema.assignments)
    expect(rows).toHaveLength(1)
    expect(rows[0].deviceId).toBe('d1')
    expect(received).toEqual(['manifest-changed'])
  })

  it('device-level assign is idempotent (replaces existing)', async () => {
    const { pl } = await setupTree()
    const pl2 = await seedPlaylist(db, { name: 'p2' })
    await handleAssignDevice(db, hub, 'd1', { playlistId: pl.id })
    await handleAssignDevice(db, hub, 'd1', { playlistId: pl2.id })

    const rows = await db.select().from(schema.assignments)
    expect(rows).toHaveLength(1)
    expect(rows[0].playlistId).toBe(pl2.id)
  })

  it('group-level assign kicks every device in the group', async () => {
    const { g, pl } = await setupTree()
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))

    await handleAssignGroup(db, hub, g.id, { playlistId: pl.id })

    expect(received.sort()).toEqual(['d1', 'd2'])
  })

  it('address-level assign kicks every device under every group in the address', async () => {
    const { a, pl } = await setupTree()
    const g2 = await seedGroup(db, a.id, 'G2')
    await seedDevice(db, { id: 'd3', groupId: g2.id })
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))
    hub.subscribeDevice('d3', () => received.push('d3'))

    await handleAssignAddress(db, hub, a.id, { playlistId: pl.id })

    expect(received.sort()).toEqual(['d1', 'd2', 'd3'])
  })

  it('unassign device removes the row and kicks', async () => {
    const { pl } = await setupTree()
    await handleAssignDevice(db, hub, 'd1', { playlistId: pl.id })

    const received: string[] = []
    hub.subscribeDevice('d1', (e) => received.push(e))

    await handleUnassignDevice(db, hub, 'd1')
    expect(await db.select().from(schema.assignments)).toHaveLength(0)
    expect(received).toEqual(['manifest-changed'])
  })

  it('unassign when no row exists is a no-op (no error, no kick)', async () => {
    await setupTree()
    const received: string[] = []
    hub.subscribeDevice('d1', (e) => received.push(e))
    await handleUnassignDevice(db, hub, 'd1')
    expect(received).toEqual([])
  })

  it('assigning unknown playlist 400s', async () => {
    const { g } = await setupTree()
    await expect(
      handleAssignGroup(db, hub, g.id, { playlistId: 9999 })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('unassign group removes and kicks group devices', async () => {
    const { g, pl } = await setupTree()
    await handleAssignGroup(db, hub, g.id, { playlistId: pl.id })
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))

    await handleUnassignGroup(db, hub, g.id)
    expect(await db.select().from(schema.assignments)).toHaveLength(0)
    expect(received.sort()).toEqual(['d1', 'd2'])
  })

  it('unassign address removes and kicks every address device', async () => {
    const { a, pl } = await setupTree()
    await handleAssignAddress(db, hub, a.id, { playlistId: pl.id })
    const received: string[] = []
    hub.subscribeDevice('d1', () => received.push('d1'))
    hub.subscribeDevice('d2', () => received.push('d2'))

    await handleUnassignAddress(db, hub, a.id)
    expect(await db.select().from(schema.assignments)).toHaveLength(0)
    expect(received.sort()).toEqual(['d1', 'd2'])
  })
})
