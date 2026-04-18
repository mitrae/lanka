import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetAddress(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [row] = await db
    .select()
    .from(schema.addresses)
    .where(eq(schema.addresses.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Address ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const idParam = getRouterParam(event, 'id')
  const id = Number(idParam)
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetAddress(useDb(), id)
})
