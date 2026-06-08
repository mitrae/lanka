import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import type { SessionUser } from '~/server/services/sessions'

export async function handleDeleteUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  id: number
): Promise<void> {
  if (caller.id === id) {
    throw createError({ statusCode: 403, message: 'You cannot delete your own account' })
  }
  const [target] = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, id))
  if (!target) throw createError({ statusCode: 404, message: `User ${id} not found` })
  if (target.role === 'super') {
    throw createError({ statusCode: 403, message: 'Super accounts cannot be deleted' })
  }
  if (caller.role === 'admin' && target.role !== 'client') {
    throw createError({ statusCode: 403, message: 'Admins may only delete client users' })
  }
  await db.delete(schema.users).where(eq(schema.users.id, id))
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeleteUser(useDb(), caller, id)
  setResponseStatus(event, 204)
  return null
})
