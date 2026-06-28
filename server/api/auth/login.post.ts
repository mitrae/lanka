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
import { authLimiters, clientIp, enforceRateLimit } from '~/server/services/rate-limit'

const BodySchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(256)
})

export async function authenticateUser(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<{ user: SessionUser; token: string } | null> {
  const body = BodySchema.parse(rawBody)
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, body.email.toLowerCase()))
  if (!u) return null
  if (!(await verifyPassword(body.password, u.passwordHash))) return null
  const token = await createSession(db, u.id)
  return {
    user: { id: u.id, email: u.email, role: u.role as Role, organizationId: u.organizationId },
    token
  }
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure
  }
}

export default defineEventHandler(async (event) => {
  // Throttle before touching the body (cheap), then again per account so neither
  // a single source nor a single targeted email can be brute-forced. Per-account
  // is IP-independent; per-IP is a generous backstop (see rate-limit.ts).
  enforceRateLimit(event, authLimiters.loginIp, clientIp(event))
  const body = await readBody(event)
  const email =
    typeof (body as any)?.email === 'string' ? (body as any).email.toLowerCase() : null
  if (email) enforceRateLimit(event, authLimiters.loginAccount, email)
  let result: { user: SessionUser; token: string } | null
  try {
    result = await authenticateUser(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  if (!result) throw createError({ statusCode: 401, message: 'Invalid email or password' })
  setCookie(
    event,
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(process.env.SESSION_COOKIE_SECURE === 'true')
  )
  return { user: result.user }
})
