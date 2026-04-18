import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetGroup(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [row] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Group ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetGroup(useDb(), id)
})
