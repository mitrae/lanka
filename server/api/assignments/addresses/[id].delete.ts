import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToAddress } from '../_emit'

export { handleAssignAddress } from './[id].put'

export async function handleUnassignAddress(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  addressId: number
): Promise<void> {
  const deleted = await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.addressId, addressId))
    .returning({ id: schema.assignments.id })
  if (deleted.length > 0) {
    await emitManifestChangedToAddress(db, hub, addressId)
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleUnassignAddress(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
