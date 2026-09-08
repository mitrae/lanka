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
import { handleManifest } from '~/server/api/devices/[id]/manifest.get'
import * as schema from '~/server/db/schema'

describe('GET /api/devices/:id/manifest handler', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('returns null when no assignment resolves (caller sends 204)', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })

    const result = await handleManifest(db, 'dev-1')
    expect(result).toBeNull()
  })

  it('returns the full manifest with items', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 15000 })
    const i = await seedMedia(db, { sha256: 'bbb', kind: 'image' })
    const pl = await seedPlaylist(db, {
      name: 'Summer',
      items: [
        { mediaId: v.id },
        { mediaId: i.id, durationMsOverride: 8000 }
      ]
    })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const result = await handleManifest(db, 'dev-1')
    expect(result).toEqual({
      playlistId: pl.id,
      playlistName: 'Summer',
      version: 1,
      items: [
        { id: expect.any(Number), type: 'video', sha256: 'aaa', durationMs: 15000 },
        { id: expect.any(Number), type: 'image', sha256: 'bbb', durationMs: 8000 }
      ],
      serverNow: expect.any(Number)
    })
  })

  it('items appear in position order', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const a = await seedMedia(db, { sha256: 'a', kind: 'image' })
    const b = await seedMedia(db, { sha256: 'b', kind: 'image' })
    const c = await seedMedia(db, { sha256: 'c', kind: 'image' })
    const pl = await seedPlaylist(db, {
      items: [
        { mediaId: a.id, durationMsOverride: 1000 },
        { mediaId: b.id, durationMsOverride: 2000 },
        { mediaId: c.id, durationMsOverride: 3000 }
      ]
    })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const r = await handleManifest(db, 'dev-1')
    expect(r?.items.map((i) => i.sha256)).toEqual(['a', 'b', 'c'])
  })

  it('updates lastSeenAt on call', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })

    const before = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()

    await handleManifest(db, 'dev-1')

    const after = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()

    expect(after!.ls).toBeInstanceOf(Date)
    expect(before?.ls ?? null).not.toEqual(after!.ls)
  })

  it('throws 404-style error for unknown device', async () => {
    await expect(handleManifest(db, 'unknown-device')).rejects.toThrow(/unknown/i)
  })

  it('uses duration_ms_override for images, native duration for videos', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'v', kind: 'video', durationMs: 15000 })
    const i = await seedMedia(db, { sha256: 'i', kind: 'image' })
    const pl = await seedPlaylist(db, {
      items: [
        { mediaId: v.id, durationMsOverride: 9999 }, // video: override ignored
        { mediaId: i.id, durationMsOverride: 7000 }
      ]
    })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const r = await handleManifest(db, 'dev-1')
    expect(r?.items[0].durationMs).toBe(15000) // video native
    expect(r?.items[1].durationMs).toBe(7000) // image override
  })

  it('carries serverNow and the next interrupt window', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 15000 })
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: v.id }] })
    await assign(db, { deviceId: 'dev-1', playlistId: pl.id })
    await db.insert(schema.interrupts).values({
      id: 1, mediaId: clip.id, atMinutes: 9 * 60, timezone: 'Europe/Kyiv', enabled: true
    })

    const now = new Date('2026-07-01T06:00:00+03:00').getTime()
    const result = await handleManifest(db, 'dev-1', now)

    expect(result!.serverNow).toBe(now)
    expect(result!.interrupt).toEqual({
      mediaId: clip.id,
      sha256: 'silence',
      durationMs: 60000,
      startsAt: new Date('2026-07-01T09:00:00+03:00').getTime(),
      endsAt: new Date('2026-07-01T09:01:00+03:00').getTime()
    })
  })

  it('omits the interrupt when it is disabled, but still sends serverNow', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 15000 })
    const clip = await seedMedia(db, { sha256: 'silence', kind: 'video', durationMs: 60000 })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: v.id }] })
    await assign(db, { deviceId: 'dev-1', playlistId: pl.id })
    await db.insert(schema.interrupts).values({
      id: 1, mediaId: clip.id, atMinutes: 9 * 60, timezone: 'Europe/Kyiv', enabled: false
    })

    const result = await handleManifest(db, 'dev-1', Date.now())
    expect(result!.interrupt).toBeUndefined()
    expect(typeof result!.serverNow).toBe('number')
  })
})
