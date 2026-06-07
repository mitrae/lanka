import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { verifyPassword } from '~/server/services/password'
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Role,
  type SessionUser
} from '~/server/services/sessions'

const BodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256)
})

export async function authenticateUser(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<{ user: SessionUser; token: string } | null> {
  const body = BodySchema.parse(rawBody)
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, body.username))
  if (!u) return null
  if (!(await verifyPassword(body.password, u.passwordHash))) return null
  const token = await createSession(db, u.id)
  return {
    user: { id: u.id, username: u.username, role: u.role as Role, organizationId: u.organizationId },
    token
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const result = await authenticateUser(useDb(), body)
  if (!result) throw createError({ statusCode: 401, message: 'Invalid username or password' })
  setCookie(event, SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  })
  return { user: result.user }
})
