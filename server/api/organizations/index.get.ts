import { asc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { organizationSelection, type OrganizationRow } from '~/server/services/organizations'

export async function handleListOrganizations(
  db: BetterSQLite3Database<typeof schema>
): Promise<OrganizationRow[]> {
  const rows = await db
    .select(organizationSelection(db))
    .from(schema.organizations)
    .orderBy(asc(schema.organizations.name))
  return rows as OrganizationRow[]
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  return handleListOrganizations(useDb())
})
