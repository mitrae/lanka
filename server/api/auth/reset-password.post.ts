import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { consumeResetToken } from '~/server/services/password-reset'
import { hashPassword } from '~/server/services/password'

const BodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(256)
})

export async function handleResetPassword(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<{ ok: true }> {
  const body = BodySchema.parse(rawBody)
  const userId = await consumeResetToken(db, body.token)
  if (userId === null) {
    throw createError({ statusCode: 400, message: 'Invalid or expired reset link' })
  }
  const passwordHash = await hashPassword(body.password)
  // Atomic: a new password must imply all of the user's sessions are gone.
  db.transaction((tx) => {
    tx.update(schema.users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .run()
    tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run()
  })
  return { ok: true }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleResetPassword(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
