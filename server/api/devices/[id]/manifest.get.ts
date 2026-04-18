import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { resolvePlaylistForDevice } from '~/server/services/resolver'

export type ManifestItem = {
  id: number
  type: 'video' | 'image'
  sha256: string
  durationMs: number
}

export type Manifest = {
  playlistId: number
  playlistName: string
  version: number
  items: ManifestItem[]
}

export async function handleManifest(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<Manifest | null> {
  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))

  if (!device) {
    throw createError({ statusCode: 404, message: `Unknown device: ${deviceId}` })
  }

  // heartbeat
  await db
    .update(schema.devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.devices.id, deviceId))

  const resolved = await resolvePlaylistForDevice(db, deviceId)
  if (!resolved) return null

  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, resolved.playlistId))

  const items = await db
    .select({
      id: schema.playlistItems.id,
      position: schema.playlistItems.position,
      durationMsOverride: schema.playlistItems.durationMsOverride,
      mediaKind: schema.media.kind,
      mediaSha: schema.media.sha256,
      mediaDur: schema.media.durationMs
    })
    .from(schema.playlistItems)
    .innerJoin(schema.media, eq(schema.media.id, schema.playlistItems.mediaId))
    .where(eq(schema.playlistItems.playlistId, resolved.playlistId))
    .orderBy(asc(schema.playlistItems.position))

  return {
    playlistId: pl.id,
    playlistName: pl.name,
    version: pl.version,
    items: items.map((r) => ({
      id: r.id,
      type: r.mediaKind as 'video' | 'image',
      sha256: r.mediaSha,
      durationMs:
        r.mediaKind === 'video' ? (r.mediaDur ?? 0) : (r.durationMsOverride ?? 0)
    }))
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  const manifest = await handleManifest(useDb(), id)
  if (!manifest) {
    setResponseStatus(event, 204)
    return null
  }
  return manifest
})
