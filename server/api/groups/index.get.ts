import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListGroups(
  db: BetterSQLite3Database<typeof schema>,
  query: { addressId?: number }
) {
  const q = db.select().from(schema.groups).orderBy(asc(schema.groups.createdAt))
  return query.addressId
    ? q.where(eq(schema.groups.addressId, query.addressId))
    : q
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const addressId = q.addressId ? Number(q.addressId) : undefined
  return handleListGroups(useDb(), { addressId })
})
