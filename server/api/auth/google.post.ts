import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { createSession, SESSION_COOKIE, type Role, type SessionUser } from '~/server/services/sessions'
import { verifyGoogleIdToken, type GoogleIdentity } from '~/server/services/google-auth'
import { sessionCookieOptions } from '~/server/api/auth/login.post'

const BodySchema = z.object({
  credential: z.string().min(1).max(8192)
})

export type VerifyIdTokenFn = (
  idToken: string,
  clientId: string
) => Promise<GoogleIdentity | null>

/**
 * Verify a Google ID token and, if it maps to an EXISTING user, mint a session.
 * Returns `null` for every non-body failure (disabled, unverified token,
 * unverified email, or no matching user) — the caller maps that to 401.
 * Throws ZodError for a malformed body (caller maps to 400).
 */
export async function handleGoogleLogin(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown,
  deps: { verify: VerifyIdTokenFn; clientId: string }
): Promise<{ user: SessionUser; token: string } | null> {
  const body = BodySchema.parse(rawBody)
  if (!deps.clientId) return null // sign-in disabled (no Client ID configured)

  const identity = await deps.verify(body.credential, deps.clientId)
  if (!identity || !identity.emailVerified) return null

  const email = identity.email.toLowerCase()
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (!u) return null

  const token = await createSession(db, u.id)
  return {
    user: { id: u.id, email: u.email, role: u.role as Role, organizationId: u.organizationId },
    token
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const config = useRuntimeConfig()
  const clientId = (config.public.googleClientId as string) || ''
  let result: { user: SessionUser; token: string } | null
  try {
    result = await handleGoogleLogin(useDb(), body, {
      verify: verifyGoogleIdToken,
      clientId
    })
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  if (!result) {
    throw createError({ statusCode: 401, message: 'No Lanka account for this Google address' })
  }
  setCookie(
    event,
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(process.env.SESSION_COOKIE_SECURE === 'true')
  )
  return { user: result.user }
})
