// tests/helpers/fixtures.ts
import type { TestDb } from './test-db'
import * as schema from '~/server/db/schema'

export async function seedAddress(db: TestDb, name = 'Mechnikova clinic') {
  const [row] = await db.insert(schema.addresses).values({ name }).returning()
  return row
}

export async function seedGroup(db: TestDb, addressId: number, name = 'Lobby') {
  const [row] = await db.insert(schema.groups).values({ addressId, name }).returning()
  return row
}

export async function seedDevice(
  db: TestDb,
  opts: { id: string; groupId?: number; name?: string }
) {
  const [row] = await db
    .insert(schema.devices)
    .values({ id: opts.id, groupId: opts.groupId, name: opts.name })
    .returning()
  return row
}

export async function seedMedia(
  db: TestDb,
  opts: {
    sha256: string
    kind: 'video' | 'image'
    filename?: string
    bytes?: number
    durationMs?: number | null
  }
) {
  const [row] = await db
    .insert(schema.media)
    .values({
      sha256: opts.sha256,
      kind: opts.kind,
      filename: opts.filename ?? `${opts.sha256}.bin`,
      bytes: opts.bytes ?? 1024,
      durationMs:
        opts.durationMs !== undefined
          ? opts.durationMs
          : opts.kind === 'video'
            ? 15000
            : null
    })
    .returning()
  return row
}

export async function seedPlaylist(
  db: TestDb,
  opts: { name?: string; items?: Array<{ mediaId: number; durationMsOverride?: number }> } = {}
) {
  const [pl] = await db
    .insert(schema.playlists)
    .values({ name: opts.name ?? 'Test' })
    .returning()
  if (opts.items) {
    for (const [i, it] of opts.items.entries()) {
      await db.insert(schema.playlistItems).values({
        playlistId: pl.id,
        mediaId: it.mediaId,
        position: i,
        durationMsOverride: it.durationMsOverride
      })
    }
  }
  return pl
}

export async function assign(
  db: TestDb,
  opts: {
    playlistId: number
    deviceId?: string
    groupId?: number
    addressId?: number
  }
) {
  const [row] = await db
    .insert(schema.assignments)
    .values({
      playlistId: opts.playlistId,
      deviceId: opts.deviceId ?? null,
      groupId: opts.groupId ?? null,
      addressId: opts.addressId ?? null
    })
    .returning()
  return row
}
