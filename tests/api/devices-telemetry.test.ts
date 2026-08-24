import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('does not overwrite surface when omitted', async () => {
    await seedDevice(db, { id: 'dev-surface' })
    await handleTelemetry(db, 'dev-surface', { currentItemId: null, surface: 'native' })
    await handleTelemetry(db, 'dev-surface', { currentItemId: null })
    const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-surface'))
    expect(row.surface).toBe('native')
  })

  async function device() {
    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    return dev
  }

  it('defaults visibility to unknown before any report', async () => {
    await setup()
    expect((await device()).visibility).toBe('unknown')
  })

  it('persists visibility and counters', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja',
      snapBacks: 7,
      focusLosses: 2,
      hiddenMs: 45_000
    })
    const dev = await device()
    expect(dev.visibility).toBe('background')
    expect(dev.foregroundPackage).toBe('com.netflix.ninja')
    expect(dev.snapBacks).toBe(7)
    expect(dev.focusLosses).toBe(2)
    expect(dev.hiddenMs).toBe(45_000)
  })

  it('a heartbeat without currentItemId does not count a play', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    const [m] = await db.select().from(schema.media).where(eq(schema.media.sha256, 'a'))
    expect(m.playCount).toBe(1)
  })

  it('a heartbeat without currentItemId leaves the current item alone', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    expect((await device()).currentItemId).toBe(item.id)
  })

  it('an explicit null currentItemId still clears', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    expect((await device()).currentItemId).toBeNull()
  })

  it('a heartbeat still refreshes lastSeenAt', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    expect((await device()).lastSeenAt).not.toBeNull()
  })

  it('stamps visibilitySince only when the state actually changes', async () => {
    // Fake timers: three synchronous better-sqlite3 writes can land in the SAME
    // millisecond, so a real clock makes the "it moved" assertion flaky.
    vi.useFakeTimers()
    try {
      await setup()
      vi.setSystemTime(new Date('2026-08-23T10:00:00Z'))
      await handleTelemetry(db, 'dev-1', { visibility: 'background' })
      const first = (await device()).visibilitySince
      expect(first).not.toBeNull()

      vi.setSystemTime(new Date('2026-08-23T10:00:10Z'))
      await handleTelemetry(db, 'dev-1', { visibility: 'background' })
      expect((await device()).visibilitySince?.getTime()).toBe(first?.getTime())

      vi.setSystemTime(new Date('2026-08-23T10:00:20Z'))
      await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
      expect((await device()).visibilitySince?.getTime()).not.toBe(first?.getTime())
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a stored foregroundPackage when the device reports foreground', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja'
    })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    expect((await device()).foregroundPackage).toBeNull()
  })

  it('does not resurrect a previous intruder when a later report has no package', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja'
    })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    await handleTelemetry(db, 'dev-1', { visibility: 'background' })
    expect((await device()).foregroundPackage).toBeNull()
  })

  it('leaves visibility untouched when the field is omitted', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { visibility: 'obscured' })
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    expect((await device()).visibility).toBe('obscured')
  })

  it('accepts a null foregroundPackage', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground', foregroundPackage: null })
    expect((await device()).foregroundPackage).toBeNull()
  })

  it('rejects an unknown visibility value', async () => {
    await setup()
    await expect(
      handleTelemetry(db, 'dev-1', { visibility: 'sideways' })
    ).rejects.toThrow()
  })
})
