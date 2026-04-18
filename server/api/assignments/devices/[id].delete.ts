import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToDevice } from '../_emit'

export { handleAssignDevice } from './[id].put'

export async function handleUnassignDevice(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  deviceId: string
): Promise<void> {
  const deleted = await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.deviceId, deviceId))
    .returning({ id: schema.assignments.id })
  if (deleted.length > 0) {
    emitManifestChangedToDevice(hub, deviceId)
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  await handleUnassignDevice(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
