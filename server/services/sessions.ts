import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

export const SESSION_COOKIE = 'lanka_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export type Role = 'super' | 'admin' | 'client'
export type SessionUser = {
  id: number
  email: string
  role: Role
  organizationId: number | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  db: BetterSQLite3Database<typeof schema>,
  userId: number,
  now = new Date()
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(schema.sessions).values({
    id: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now
  })
  return token
}

export async function getSessionUser(
  db: BetterSQLite3Database<typeof schema>,
  token: string | undefined,
  now = new Date()
): Promise<SessionUser | null> {
  if (!token) return null
  const [row] = await db
    .select({
      expiresAt: schema.sessions.expiresAt,
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      organizationId: schema.users.organizationId
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, hashToken(token)))
  if (!row) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    organizationId: row.organizationId
  }
}

export async function deleteSession(
  db: BetterSQLite3Database<typeof schema>,
  token: string | undefined
): Promise<void> {
  if (!token) return
  await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)))
}
