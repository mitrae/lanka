import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign, seedAddress, seedDevice, seedGroup, seedMedia, seedPlaylist
} from '../helpers/fixtures'
import { handleGetInterrupt, handlePutInterrupt } from '~/server/services/interrupt'

const AT_9AM = 9 * 60
const at = (iso: string) => new Date(iso).getTime()

describe('interrupt config API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('reports no config on a fresh database', async () => {
    const res = await handleGetInterrupt(db, Date.now())
    expect(res.config).toBeNull()
    expect(res.window).toBeNull()
  })

  it('stores a config and computes the next window from the media duration', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const now = at('2026-07-01T06:00:00+03:00')
    const res = await handlePutInterrupt(
      db,
      { mediaId: m.id, atMinutes: AT_9AM, enabled: true, label: 'Хвилина мовчання' },
      now
    )
    expect(res.config).toMatchObject({ mediaId: m.id, atMinutes: AT_9AM, durationMs: 60_000 })
    expect(res.window).toEqual({
      startsAt: at('2026-07-01T09:00:00+03:00'),
      endsAt: at('2026-07-01T09:01:00+03:00')
    })
  })

  it('keeps exactly one row across repeated PUTs', async () => {
    const a = await seedMedia(db, { sha256: 'a', kind: 'video', durationMs: 60_000 })
    const b = await seedMedia(db, { sha256: 'b', kind: 'video', durationMs: 30_000 })
    await handlePutInterrupt(db, { mediaId: a.id, atMinutes: AT_9AM, enabled: true }, Date.now())
    const res = await handlePutInterrupt(db, { mediaId: b.id, atMinutes: 600, enabled: true }, Date.now())
    expect(res.config).toMatchObject({ mediaId: b.id, atMinutes: 600 })
    const rows = await db.select().from((await import('~/server/db/schema')).interrupts)
    expect(rows).toHaveLength(1)
  })

  it('reports no window while disabled, but keeps the config', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const res = await handlePutInterrupt(
      db, { mediaId: m.id, atMinutes: AT_9AM, enabled: false }, Date.now()
    )
    expect(res.config!.enabled).toBe(false)
    expect(res.window).toBeNull()
  })

  it('rejects an image — the interrupt is a video clip', async () => {
    const img = await seedMedia(db, { sha256: 'img', kind: 'image' })
    await expect(
      handlePutInterrupt(db, { mediaId: img.id, atMinutes: AT_9AM, enabled: true }, Date.now())
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects media that does not exist', async () => {
    await expect(
      handlePutInterrupt(db, { mediaId: 999, atMinutes: AT_9AM, enabled: true }, Date.now())
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an out-of-range time', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    await expect(
      handlePutInterrupt(db, { mediaId: m.id, atMinutes: 1440, enabled: true }, Date.now())
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('flags devices with no playlist — they receive a 204 and cannot observe', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'assigned', groupId: grp.id })
    await seedDevice(db, { id: 'orphan', groupId: grp.id })
    const pl = await seedPlaylist(db, { name: 'P', items: [{ mediaId: m.id }] })
    await assign(db, { deviceId: 'assigned', playlistId: pl.id })

    await handlePutInterrupt(db, { mediaId: m.id, atMinutes: AT_9AM, enabled: true }, Date.now())
    const res = await handleGetInterrupt(db, Date.now())
    const byId = Object.fromEntries(res.devices.map((d) => [d.id, d]))
    expect(byId.assigned.hasPlaylist).toBe(true)
    expect(byId.orphan.hasPlaylist).toBe(false)
  })

  it('marks a device observed only when its report matches TODAY\'s window', async () => {
    const m = await seedMedia(db, { sha256: 'clip', kind: 'video', durationMs: 60_000 })
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'today', groupId: grp.id })
    await seedDevice(db, { id: 'yesterday', groupId: grp.id })
    const now = at('2026-07-01T10:00:00+03:00')
    await handlePutInterrupt(db, { mediaId: m.id, atMinutes: AT_9AM, enabled: true }, now)

    const schema = await import('~/server/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.update(schema.devices)
      .set({ lastInterruptAt: new Date(at('2026-07-01T09:00:00+03:00')) })
      .where(eq(schema.devices.id, 'today'))
    await db.update(schema.devices)
      .set({ lastInterruptAt: new Date(at('2026-06-30T09:00:00+03:00')) })
      .where(eq(schema.devices.id, 'yesterday'))

    const res = await handleGetInterrupt(db, now)
    const byId = Object.fromEntries(res.devices.map((d) => [d.id, d]))
    expect(byId.today.observedToday).toBe(true)
    expect(byId.yesterday.observedToday).toBe(false)
  })
})
