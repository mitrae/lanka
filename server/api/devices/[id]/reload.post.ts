import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'

export async function handleReloadDevice(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  deviceId: string
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!row) {
    throw createError({
      statusCode: 404,
      message: `Device ${deviceId} not found`
    })
  }
  hub.emitDevice(deviceId, 'reload', null)
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  await handleReloadDevice(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
