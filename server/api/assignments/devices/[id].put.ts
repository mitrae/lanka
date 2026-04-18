import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToDevice } from '../_emit'

const BodySchema = z.object({ playlistId: z.number().int().positive() })

export async function handleAssignDevice(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  deviceId: string,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, body.playlistId))
  if (!pl) {
    throw createError({ statusCode: 400, message: `Unknown playlistId` })
  }
  const [dev] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!dev) {
    throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })
  }

  await db.delete(schema.assignments).where(eq(schema.assignments.deviceId, deviceId))
  const [row] = await db
    .insert(schema.assignments)
    .values({ playlistId: body.playlistId, deviceId })
    .returning()

  emitManifestChangedToDevice(hub, deviceId)
  return row
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleAssignDevice(useDb(), useEventsHub(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
