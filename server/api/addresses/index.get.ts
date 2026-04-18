import { asc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListAddresses(
  db: BetterSQLite3Database<typeof schema>
) {
  return db.select().from(schema.addresses).orderBy(asc(schema.addresses.createdAt))
}

export default defineEventHandler(() => handleListAddresses(useDb()))
