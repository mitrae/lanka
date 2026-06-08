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

/**
 * Validates + marks the token used (single-use). Returns the userId or null.
 * The read + mark-used run in a single synchronous better-sqlite3 transaction
 * so two concurrent consumes of the same token can't both succeed (no TOCTOU).
 */
export async function consumeResetToken(
  db: BetterSQLite3Database<typeof schema>,
  token: string,
  now = new Date()
): Promise<number | null> {
  const id = hashToken(token)
  return db.transaction((tx) => {
    const [row] = tx
      .select({
        usedAt: schema.passwordResetTokens.usedAt,
        expiresAt: schema.passwordResetTokens.expiresAt,
        userId: schema.passwordResetTokens.userId
      })
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.id, id))
      .all()
    if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) return null
    tx
      .update(schema.passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(schema.passwordResetTokens.id, id))
      .run()
    return row.userId
  })
}
