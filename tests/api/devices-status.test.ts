import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { assign, seedAddress, seedDevice, seedGroup, seedMedia, seedPlaylist } from '../helpers/fixtures'
import { handleDeviceStatus } from '~/server/api/devices/[id]/status.get'
import { handleTelemetry } from '~/server/api/devices/[id]/telemetry.post'
import { handleRegister } from '~/server/api/devices/register.post'
import * as schema from '~/server/db/schema'

describe('GET /api/devices/:id/status handler', () => {
  let db: TestDb, close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  async function setup() {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const m = await seedMedia(db, { sha256: 'sha-1', kind: 'video', filename: 'clip.mp4' })
    const pl = await seedPlaylist(db, { name: 'Lobby', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })
    const [item] = await db.select().from(schema.playlistItems).where(eq(schema.playlistItems.playlistId, pl.id))
    return { item, media: m }
  }

  it('reports current item + playlist after a telemetry start', async () => {
    const { item, media } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.online).toBe(true)
    expect(s.currentItem?.mediaId).toBe(media.id)
    expect(s.currentItem?.filename).toBe('clip.mp4')
    expect(s.playlistName).toBe('Lobby')
  })

  it('currentItem is null when nothing is playing', async () => {
    await setup()
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.currentItem).toBeNull()
  })

  it('online is false when last seen is stale', async () => {
    await setup()
    await db.update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.devices.id, 'dev-1'))
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.online).toBe(false)
  })

  it('404s on unknown device', async () => {
    await expect(handleDeviceStatus(db, 'ghost')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns the device surface', async () => {
    await handleRegister(db, { deviceId: 'dev-s', playerVersion: '0.1.0', surface: 'native' })
    const status = await handleDeviceStatus(db, 'dev-s')
    expect(status.surface).toBe('native')
  })
})
