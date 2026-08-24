import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { findOrganization, type OrganizationRow } from '~/server/services/organizations'

export async function handleGetOrganization(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<OrganizationRow> {
  const row = await findOrganization(db, id)
  if (!row) throw createError({ statusCode: 404, message: `Organization ${id} not found` })
  return row
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad organization id' })
  return handleGetOrganization(useDb(), id)
})
