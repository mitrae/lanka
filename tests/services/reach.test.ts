import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  seedAddress, seedGroup, seedDevice, seedMedia, seedPlaylist, assign, seedOrganization
} from '../helpers/fixtures'
import { computeOrgReach } from '~/server/services/reach'
import * as schema from '~/server/db/schema'
import { eq } from 'drizzle-orm'

describe('computeOrgReach', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('counts scheduled / online / showing-now screens for the org-owned media only', async () => {
    const org = await seedOrganization(db, 'Acme')
    const other = await seedOrganization(db, 'Other')
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    const now = new Date('2026-06-07T12:00:00Z')

    // device online (seen 1 min ago)
    await seedDevice(db, { id: 'd1', groupId: grp.id })
    await db.update(schema.devices).set({ lastSeenAt: new Date(now.getTime() - 60_000) }).where(eq(schema.devices.id, 'd1'))

    const mine = await seedMedia(db, { sha256: 'mine', kind: 'image', organizationId: org.id })
    const theirs = await seedMedia(db, { sha256: 'theirs', kind: 'image', organizationId: other.id })
    const pl = await seedPlaylist(db, { items: [{ mediaId: mine.id }, { mediaId: theirs.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'd1' })

    // d1 is currently showing `mine`
    const [item] = await db.select().from(schema.playlistItems).where(eq(schema.playlistItems.mediaId, mine.id))
    await db.update(schema.devices).set({ currentItemId: item.id }).where(eq(schema.devices.id, 'd1'))

    const reach = await computeOrgReach(db, org.id, now)
    expect(reach!.organization.name).toBe('Acme')
    expect(reach!.media).toHaveLength(1) // only Acme's media
    expect(reach!.media[0]).toMatchObject({
      mediaId: mine.id, screensScheduled: 1, screensOnline: 1, screensShowingNow: 1
    })
    expect(reach!.totals).toMatchObject({ mediaCount: 1, screensReached: 1, screensOnline: 1, showingNow: 1 })
  })

  it('returns zero counts when the org media is on no playlist', async () => {
    const org = await seedOrganization(db)
    await seedMedia(db, { sha256: 'lonely', kind: 'image', organizationId: org.id })
    const reach = await computeOrgReach(db, org.id, new Date())
    expect(reach!.media[0].screensScheduled).toBe(0)
    expect(reach!.totals.screensReached).toBe(0)
  })

  it('returns null for an unknown organization', async () => {
    expect(await computeOrgReach(db, 999, new Date())).toBeNull()
  })

  it('dedups a device across multiple org media in the org totals', async () => {
    const org = await seedOrganization(db, 'Acme')
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    const now = new Date('2026-06-07T12:00:00Z')

    // single online device
    await seedDevice(db, { id: 'd1', groupId: grp.id })
    await db.update(schema.devices).set({ lastSeenAt: new Date(now.getTime() - 60_000) }).where(eq(schema.devices.id, 'd1'))

    // two org-owned media in one playlist assigned to the single device
    const a = await seedMedia(db, { sha256: 'a', kind: 'image', organizationId: org.id })
    const b = await seedMedia(db, { sha256: 'b', kind: 'image', organizationId: org.id })
    const pl = await seedPlaylist(db, { items: [{ mediaId: a.id }, { mediaId: b.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'd1' })

    const reach = await computeOrgReach(db, org.id, now)
    expect(reach!.media).toHaveLength(2)
    // each media reaches the one device
    for (const m of reach!.media) expect(m.screensScheduled).toBe(1)
    // but the device is counted once across the union, not twice
    expect(reach!.totals.screensReached).toBe(1)
    expect(reach!.totals.screensOnline).toBe(1)
  })

  it('counts only device_errors whose sha256 matches the org media', async () => {
    const org = await seedOrganization(db)
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'd1', groupId: grp.id })

    const m = await seedMedia(db, { sha256: 'errm', kind: 'image', organizationId: org.id })

    // two errors for this org media...
    await db.insert(schema.deviceErrors).values({ deviceId: 'd1', sha256: 'errm', message: 'boom 1' })
    await db.insert(schema.deviceErrors).values({ deviceId: 'd1', sha256: 'errm', message: 'boom 2' })
    // ...and one unrelated error that must NOT be counted
    await db.insert(schema.deviceErrors).values({ deviceId: 'd1', sha256: 'other', message: 'unrelated' })

    const reach = await computeOrgReach(db, org.id, new Date())
    const mine = reach!.media.find((x) => x.mediaId === m.id)!
    expect(mine.recentErrors).toBe(2)
  })
})
