import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetDevice } from './[id].get'
export { handleUpdateDevice } from './[id].patch'

export async function handleDeleteDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string
): Promise<void> {
  const result = await db
    .delete(schema.devices)
    .where(eq(schema.devices.id, id))
    .returning({ id: schema.devices.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Device ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  await handleDeleteDevice(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
