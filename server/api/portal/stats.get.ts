import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { computeOrgReach, type OrgReach } from '~/server/services/reach'
import type { SessionUser } from '~/server/services/sessions'

export async function handlePortalStats(
  db: BetterSQLite3Database<typeof schema>,
  user: SessionUser
): Promise<OrgReach> {
  if (user.organizationId == null) {
    throw createError({ statusCode: 400, message: 'Client is not linked to an organization' })
  }
  const reach = await computeOrgReach(db, user.organizationId)
  if (!reach) throw createError({ statusCode: 404, message: 'Organization not found' })
  return reach
}

export default defineEventHandler(async (event) => {
  const user = requireRole(event.context.user, ['client'])
  return handlePortalStats(useDb(), user)
})
