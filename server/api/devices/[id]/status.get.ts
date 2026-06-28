import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

// ~3 missed manifest polls (poll cadence is 30s) before we call a device
// offline. Intentionally more lenient than the device-list view's online tier
// in devices/index.get.ts — do not unify into a shared constant here.
const ONLINE_WINDOW_MS = 90_000

export type DeviceStatus = {
  online: boolean
  lastSeenAt: number | null
  apkVersion: string | null
  surface: 'webview' | 'native'
  currentItem: { mediaId: number; filename: string; kind: 'video' | 'image'; sha256: string } | null
  playlistName: string | null
}

export async function handleDeviceStatus(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<DeviceStatus> {
  const [device] = await db.select().from(schema.devices).where(eq(schema.devices.id, deviceId))
  if (!device) throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })

  const lastSeenAt = device.lastSeenAt?.getTime() ?? null
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
  return { online, lastSeenAt, apkVersion: device.apkVersion ?? null, surface: (device.surface as 'webview' | 'native'), currentItem, playlistName }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  return handleDeviceStatus(useDb(), id)
})
