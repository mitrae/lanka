// tests/integration/sync-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleRegister } from '~/server/api/devices/register.post'
import { handleManifest } from '~/server/api/devices/[id]/manifest.get'
import { ingestMedia } from '~/server/api/media.post'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'
import * as schema from '~/server/db/schema'

describe('sync flow end-to-end', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-int-'))
    store = new LocalDiskStore(dir)
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('device registers → gets null manifest → admin creates content → device gets manifest', async () => {
    // 1. Device self-registers
    const reg = await handleRegister(db, {
      deviceId: 'tv-1',
      playerVersion: '0.1.0'
    })
    expect(reg.claimed).toBe(false)

    // 2. Still unclaimed, manifest is null
    const m0 = await handleManifest(db, 'tv-1')
    expect(m0).toBeNull()

    // 3. Admin creates address + group, moves device into group
    const [addr] = await db.insert(schema.addresses).values({ name: 'Clinic' }).returning()
    const [grp] = await db
      .insert(schema.groups)
      .values({ addressId: addr.id, name: 'Lobby' })
      .returning()
    await db
      .update(schema.devices)
      .set({ groupId: grp.id, name: 'TV-Lobby-1' })
      .where(eq(schema.devices.id, 'tv-1'))

    // 4. Admin uploads media
    const v = await ingestMedia(db, store, {
      stream: Readable.from([Buffer.from('video-bytes')]),
      filename: 'promo.mp4',
      kind: 'video',
      durationMs: 15000
    })
    const i = await ingestMedia(db, store, {
      stream: Readable.from([Buffer.from('image-bytes')]),
      filename: 'logo.png',
      kind: 'image'
    })

    // 5. Admin creates playlist + items
    const [pl] = await db.insert(schema.playlists).values({ name: 'Summer' }).returning()
    await db.insert(schema.playlistItems).values([
      { playlistId: pl.id, mediaId: v.id, position: 0 },
      { playlistId: pl.id, mediaId: i.id, position: 1, durationMsOverride: 8000 }
    ])

    // 6. Admin assigns playlist to the group
    await db
      .insert(schema.assignments)
      .values({ playlistId: pl.id, groupId: grp.id })

    // 7. Device polls — now gets manifest via group inheritance
    const m1 = await handleManifest(db, 'tv-1')
    expect(m1).not.toBeNull()
    expect(m1!.playlistId).toBe(pl.id)
    expect(m1!.version).toBe(1)
    expect(m1!.items).toHaveLength(2)
    expect(m1!.items[0]).toMatchObject({
      type: 'video',
      sha256: v.sha256,
      durationMs: 15000
    })
    expect(m1!.items[1]).toMatchObject({
      type: 'image',
      sha256: i.sha256,
      durationMs: 8000
    })

    // 8. Admin edits playlist (bump version)
    await bumpPlaylistVersion(db, pl.id)
    const m2 = await handleManifest(db, 'tv-1')
    expect(m2!.version).toBe(2)

    // 9. Admin creates an override at device level — this wins over group
    const [pl2] = await db
      .insert(schema.playlists)
      .values({ name: 'Override' })
      .returning()
    await db
      .insert(schema.playlistItems)
      .values({ playlistId: pl2.id, mediaId: v.id, position: 0 })
    await db
      .insert(schema.assignments)
      .values({ playlistId: pl2.id, deviceId: 'tv-1' })

    const m3 = await handleManifest(db, 'tv-1')
    expect(m3!.playlistId).toBe(pl2.id) // device-level overrides group-level
  })
})
