import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToGroup } from '../_emit'

export { handleAssignGroup } from './[id].put'

export async function handleUnassignGroup(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  groupId: number
): Promise<void> {
  const deleted = await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.groupId, groupId))
    .returning({ id: schema.assignments.id })
  if (deleted.length > 0) {
    await emitManifestChangedToGroup(db, hub, groupId)
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleUnassignGroup(useDb(), useEventsHub(), id)
  setResponseStatus(event, 204)
  return null
})
