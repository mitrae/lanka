import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetMedia(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [row] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Media ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetMedia(useDb(), id)
})
