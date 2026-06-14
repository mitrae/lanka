import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const ONLINE_WINDOW_MS = 90_000

export type DeviceStatus = {
  online: boolean
  lastSeenAt: number | null
  currentItem: { mediaId: number; filename: string; kind: 'video' | 'image'; sha256: string } | null
  playlistName: string | null
}

export async function handleDeviceStatus(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<DeviceStatus> {
  const [device] = await db.select().from(schema.devices).where(eq(schema.devices.id, deviceId))
  if (!device) throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })

  const lastSeenAt = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null
  const online = lastSeenAt !== null && Date.now() - lastSeenAt < ONLINE_WINDOW_MS

  let currentItem: DeviceStatus['currentItem'] = null
  let playlistName: string | null = null
  if (device.currentItemId !== null) {
    const [row] = await db
      .select({
        mediaId: schema.media.id,
        filename: schema.media.filename,
        kind: schema.media.kind,
        sha256: schema.media.sha256,
        playlistName: schema.playlists.name
      })
      .from(schema.playlistItems)
      .innerJoin(schema.media, eq(schema.media.id, schema.playlistItems.mediaId))
      .innerJoin(schema.playlists, eq(schema.playlists.id, schema.playlistItems.playlistId))
      .where(eq(schema.playlistItems.id, device.currentItemId))
    if (row) {
      currentItem = { mediaId: row.mediaId, filename: row.filename, kind: row.kind as 'video' | 'image', sha256: row.sha256 }
      playlistName = row.playlistName
    }
  }
  return { online, lastSeenAt, currentItem, playlistName }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  return handleDeviceStatus(useDb(), id)
})
