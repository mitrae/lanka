import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { hashPassword, generatePassword } from '~/server/services/password'
import { requireManageableUser } from '~/server/services/user-admin'
import type { SessionUser } from '~/server/services/sessions'

export interface ResetUserPasswordResult {
  generatedPassword: string
}

/**
 * Admin-initiated reset, for the user who cannot work the emailed
 * forgot-password link. Same shape as account creation: a fresh random
 * password shown to the caller exactly once, never stored in the clear.
 */
export async function handleResetUserPassword(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  id: number
): Promise<ResetUserPasswordResult> {
  await requireManageableUser(db, caller, id)
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  // Atomic: a new password must imply all of the user's sessions are gone.
  db.transaction((tx) => {
    tx.update(schema.users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(schema.users.id, id))
      .run()
    tx.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run()
  })
  return { generatedPassword: password }
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad user id' })
  return handleResetUserPassword(useDb(), caller, id)
})
