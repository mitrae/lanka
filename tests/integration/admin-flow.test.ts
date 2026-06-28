// tests/integration/admin-flow.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { EventsHub } from '~/server/services/events'
import { handleRegister } from '~/server/api/devices/register.post'
import { handleManifest } from '~/server/api/devices/[id]/manifest.get'
import { ingestMedia } from '~/server/api/media.post'
import { ensureQuality } from '~/server/services/transcode'
import { handleCreateAddress } from '~/server/api/addresses/index.post'
import { handleCreateGroup } from '~/server/api/groups/index.post'
import { handleUpdateDevice } from '~/server/api/devices/[id].delete'
import { handleCreatePlaylist } from '~/server/api/playlists/index.post'
import { handleReplacePlaylistItems } from '~/server/api/playlists/[id]/items.put'
import { handleAssignGroup } from '~/server/api/assignments/groups/[id].delete'
import { handleAssignDevice } from '~/server/api/assignments/devices/[id].delete'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

vi.mock('~/server/services/transcode')

beforeEach(() => {
  vi.mocked(ensureQuality).mockImplementation(async (inPath) => ({
    path: inPath,
    transcoded: false,
    probe: { codec: 'h264', profile: 'Main', pixFmt: 'yuv420p', width: 1280, height: 720, durationMs: 1000, audioCodec: 'aac' }
  }))
})

describe('admin flow end-to-end', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore
  let hub: EventsHub

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-admin-'))
    store = new LocalDiskStore(dir)
    hub = new EventsHub()
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks register → claim → upload → playlist → assign → manifest, then device-level override', async () => {
    await handleRegister(db, { deviceId: 'tv-1', playerVersion: '0.1.0' })

    const addr = await handleCreateAddress(db, { name: 'Clinic' })
    const grp = await handleCreateGroup(db, {
      addressId: addr.id,
      name: 'Lobby'
    })

    await handleUpdateDevice(db, 'tv-1', { groupId: grp.id, name: 'TV-Lobby' })

    const videoBuf = Buffer.from('FAKE-VIDEO-BYTES')
    const video = await ingestMedia(db, store, {
      stream: Readable.from([videoBuf]),
      filename: 'ad.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      durationMs: 15000
    })

    const imageBuf = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 3,
        background: { r: 0, g: 0, b: 255 }
      }
    })
      .png()
      .toBuffer()
    const image = await ingestMedia(db, store, {
      stream: Readable.from([imageBuf]),
      filename: 'logo.png',
      kind: 'image',
      mimeType: 'image/png'
    })
    expect(image.mimeType).toBe('image/png')
    expect(image.thumbnailBytes).toBeGreaterThan(0)
    expect(await store.hasThumbnail(image.sha256)).toBe(true)

    const pl = await handleCreatePlaylist(db, { name: 'Summer' })
    await handleReplacePlaylistItems(db, pl.id, {
      items: [
        { mediaId: video.id },
        { mediaId: image.id, durationMsOverride: 8000 }
      ]
    })

    const received: string[] = []
    hub.subscribeDevice('tv-1', (e) => received.push(e))
    await handleAssignGroup(db, hub, grp.id, { playlistId: pl.id })
    expect(received).toEqual(['manifest-changed'])

    const m = await handleManifest(db, 'tv-1')
    expect(m).not.toBeNull()
    expect(m!.playlistId).toBe(pl.id)
    expect(m!.version).toBe(2)
    expect(m!.items).toHaveLength(2)
    expect(m!.items[0]).toMatchObject({
      type: 'video',
      sha256: video.sha256,
      durationMs: 1000 // from probe (mock returns durationMs: 1000)
    })
    expect(m!.items[1]).toMatchObject({
      type: 'image',
      sha256: image.sha256,
      durationMs: 8000
    })

    const pl2 = await handleCreatePlaylist(db, { name: 'Override' })
    await handleReplacePlaylistItems(db, pl2.id, {
      items: [{ mediaId: video.id }]
    })
    await handleAssignDevice(db, hub, 'tv-1', { playlistId: pl2.id })

    const m2 = await handleManifest(db, 'tv-1')
    expect(m2!.playlistId).toBe(pl2.id)

    await bumpPlaylistVersion(db, pl2.id)
    const m3 = await handleManifest(db, 'tv-1')
    expect(m3!.version).toBe(m2!.version + 1)
  })
})
