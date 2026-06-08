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
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() })
    .where(eq(schema.users.id, userId))
  // Force re-login everywhere.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
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
