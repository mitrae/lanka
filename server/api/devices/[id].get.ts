import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetDevice(
  db: BetterSQLite3Database<typeof schema>,
  id: string
) {
  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Device ${id} not found` })
  }
  return row
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  return handleGetDevice(useDb(), id)
})
