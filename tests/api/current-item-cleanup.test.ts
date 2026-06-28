import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist, seedDevice } from '../helpers/fixtures'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleReplacePlaylistItems } from '~/server/api/playlists/[id]/items.put'
import { handleDeletePlaylist } from '~/server/api/playlists/[id].delete'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

// The schema deliberately omits an FK on devices.current_item_id (a circular
// devices→playlist_items→playlists reference). Its comment makes nulling that
// column the delete handlers' job: "null this column whenever the referenced
// item dies." These tests pin that invariant for the three paths that can kill
// a playlist_items row: items.put (replace), playlist delete, media force-delete.

async function firstItemId(db: TestDb, playlistId: number): Promise<number> {
  const [item] = await db
    .select()
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.playlistId, playlistId))
  return item.id
}

async function setCurrentItem(db: TestDb, deviceId: string, itemId: number) {
  await db
    .update(schema.devices)
    .set({ currentItemId: itemId })
    .where(eq(schema.devices.id, deviceId))
}

async function currentItemOf(db: TestDb, deviceId: string): Promise<number | null> {
  const [d] = await db
    .select({ currentItemId: schema.devices.currentItemId })
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  return d.currentItemId
}

describe('devices.current_item_id orphan cleanup', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-cic-'))
    store = new LocalDiskStore(dir)
  })

  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('items.put nulls current_item_id for a device pointing at a replaced item', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const v2 = await seedMedia(db, { sha256: 'v2', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: v.id }] })
    const oldItemId = await firstItemId(db, pl.id)
    const dev = await seedDevice(db, { id: 'dev-1' })
    await setCurrentItem(db, dev.id, oldItemId)

    await handleReplacePlaylistItems(db, pl.id, { items: [{ mediaId: v2.id }] })

    expect(await currentItemOf(db, dev.id)).toBeNull()
  })

  it('items.put leaves a device pointing at an unrelated item untouched', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const plA = await seedPlaylist(db, { name: 'A', items: [{ mediaId: v.id }] })
    const plB = await seedPlaylist(db, { name: 'B', items: [{ mediaId: v.id }] })
    const bItemId = await firstItemId(db, plB.id)
    const dev = await seedDevice(db, { id: 'dev-1' })
    await setCurrentItem(db, dev.id, bItemId)

    // Replacing playlist A's items must not touch a device playing B's item.
    await handleReplacePlaylistItems(db, plA.id, { items: [{ mediaId: v.id }] })

    expect(await currentItemOf(db, dev.id)).toBe(bItemId)
  })

  it('playlist delete nulls current_item_id for a device on that playlist', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: v.id }] })
    const itemId = await firstItemId(db, pl.id)
    const dev = await seedDevice(db, { id: 'dev-1' })
    await setCurrentItem(db, dev.id, itemId)

    await handleDeletePlaylist(db, pl.id)

    expect(await currentItemOf(db, dev.id)).toBeNull()
  })

  it('media force-delete nulls current_item_id for a device on the removed item', async () => {
    const v = await seedMedia(db, { sha256: 'v', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: v.id }] })
    const itemId = await firstItemId(db, pl.id)
    const dev = await seedDevice(db, { id: 'dev-1' })
    await setCurrentItem(db, dev.id, itemId)

    await handleDeleteMedia(db, store, v.id, { force: true })

    expect(await currentItemOf(db, dev.id)).toBeNull()
  })
})
