import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import {
  findAdminUser,
  requireManageableUser,
  type AdminUserRow
} from '~/server/services/user-admin'
import type { SessionUser } from '~/server/services/sessions'

export async function handleGetUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  id: number
): Promise<AdminUserRow> {
  await requireManageableUser(db, caller, id)
  return (await findAdminUser(db, id))!
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad user id' })
  return handleGetUser(useDb(), caller, id)
})
