import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { resolvePlaylistForDevice } from '~/server/services/resolver'
import {
  type AssignmentContext,
  directOnly,
  findDirectAssignment
} from '~/server/services/assignments'

export type DeviceDetail = typeof schema.devices.$inferSelect & AssignmentContext

export async function handleGetDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string
): Promise<DeviceDetail> {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Device ${id} not found` })
  }

  const direct = await findDirectAssignment(db, { level: 'device', id })
  let context = directOnly(direct, 'device')

  // A direct assignment always wins, so only walk up when there isn't one.
  if (!direct) {
    const resolved = await resolvePlaylistForDevice(db, id)
    if (resolved) {
      const [pl] = await db
        .select({ name: schema.playlists.name })
        .from(schema.playlists)
        .where(eq(schema.playlists.id, resolved.playlistId))
      context = {
        directPlaylistId: null,
        directPlaylistName: null,
        effectivePlaylistId: resolved.playlistId,
        effectivePlaylistName: pl?.name ?? null,
        effectiveLevel: resolved.level
      }
    }
  }

  return { ...row, ...context }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  return handleGetDevice(useDb(), id)
})
