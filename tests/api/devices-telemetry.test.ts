import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedMedia,
  seedPlaylist
} from '../helpers/fixtures'
import { handleTelemetry } from '~/server/api/devices/[id]/telemetry.post'
import { handleRegister } from '~/server/api/devices/register.post'
import * as schema from '~/server/db/schema'

describe('POST /api/devices/:id/telemetry handler', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  async function setup() {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })
    const [item] = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, pl.id))
    return { item }
  }

  it('updates currentItemId', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    expect(dev.currentItemId).toBe(item.id)
  })

  it('accepts null currentItemId (e.g. no content state)', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    expect(dev.currentItemId).toBeNull()
  })

  it('updates lastSeenAt', async () => {
    await setup()
    const beforeRow = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()
    await new Promise((r) => setTimeout(r, 10))
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const afterRow = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()
    expect(afterRow!.ls!.getTime()).toBeGreaterThan(beforeRow!.ls?.getTime() ?? 0)
  })

  it('404s on unknown device', async () => {
    await expect(
      handleTelemetry(db, 'ghost', { currentItemId: null })
    ).rejects.toThrow(/unknown/i)
  })

  it('rejects currentItemId that references an unknown playlist_item', async () => {
    await setup()
    await expect(
      handleTelemetry(db, 'dev-1', { currentItemId: 99999 })
    ).rejects.toThrow()
  })

  it('persists error payloads to device_errors', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      currentItemId: null,
      error: { sha256: 'bad-file-sha', message: 'decode failure' }
    })

    const rows = await db.select().from(schema.deviceErrors)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: 'dev-1',
      sha256: 'bad-file-sha',
      message: 'decode failure'
    })
    expect(rows[0].createdAt).toBeInstanceOf(Date)
  })

  it('does not write to device_errors when no error field', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const rows = await db.select().from(schema.deviceErrors)
    expect(rows).toHaveLength(0)
  })

  it('increments media.play_count on a real item start', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const [m] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
    expect(m.playCount).toBe(1)
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const [m2] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
    expect(m2.playCount).toBe(2)
  })

  it('does NOT count a failed item (error present)', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id, error: { message: 'decode failed' } })
    const [m] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
    expect(m.playCount).toBe(0)
  })

  it('does NOT count a clear (currentItemId null)', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const [m] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
    expect(m.playCount).toBe(0)
  })

  it('stores apkVersion when provided', async () => {
    await seedDevice(db, { id: 'dev-apk' })
    await handleTelemetry(db, 'dev-apk', { currentItemId: null, apkVersion: '1.2.3' })
    const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-apk'))
    expect(row.apkVersion).toBe('1.2.3')
  })

  it('ignores missing apkVersion without error', async () => {
    await seedDevice(db, { id: 'dev-noapk' })
    await expect(
      handleTelemetry(db, 'dev-noapk', { currentItemId: null })
    ).resolves.toBeUndefined()
  })

  it('persists surface from telemetry', async () => {
    await handleRegister(db, { deviceId: 'dev-t', playerVersion: '0.1.0' })
    await handleTelemetry(db, 'dev-t', { currentItemId: null, surface: 'native' })
    const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-t'))
    expect(row.surface).toBe('native')
  })
})
