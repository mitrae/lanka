import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

export const RESET_TTL_MS = 60 * 60 * 1000 // 1 hour

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createResetToken(
  db: BetterSQLite3Database<typeof schema>,
  userId: number,
  now = new Date()
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(schema.passwordResetTokens).values({
    id: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
    createdAt: now
  })
  return token
}

/** Validates + marks the token used (single-use). Returns the userId or null. */
export async function consumeResetToken(
  db: BetterSQLite3Database<typeof schema>,
  token: string,
  now = new Date()
): Promise<number | null> {
  const [row] = await db
    .select()
    .from(schema.passwordResetTokens)
    .where(eq(schema.passwordResetTokens.id, hashToken(token)))
  if (!row) return null
  if (row.usedAt) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  await db
    .update(schema.passwordResetTokens)
    .set({ usedAt: now })
    .where(eq(schema.passwordResetTokens.id, row.id))
  return row.userId
}
