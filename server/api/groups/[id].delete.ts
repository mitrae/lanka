import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetGroup } from './[id].get'
export { handleUpdateGroup } from './[id].patch'

export async function handleDeleteGroup(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  const result = await db
    .delete(schema.groups)
    .where(eq(schema.groups.id, id))
    .returning({ id: schema.groups.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Group ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeleteGroup(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
