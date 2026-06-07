import { asc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

export async function handleListOrganizations(db: BetterSQLite3Database<typeof schema>) {
  return db.select().from(schema.organizations).orderBy(asc(schema.organizations.name))
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  return handleListOrganizations(useDb())
})
