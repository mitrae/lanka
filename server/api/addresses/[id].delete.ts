import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetAddress } from './[id].get'
export { handleUpdateAddress } from './[id].patch'

export async function handleDeleteAddress(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  const result = await db
    .delete(schema.addresses)
    .where(eq(schema.addresses.id, id))
    .returning({ id: schema.addresses.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Address ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeleteAddress(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
