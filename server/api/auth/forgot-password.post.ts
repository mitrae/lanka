import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { createResetToken } from '~/server/services/password-reset'
import { useMailer, type MailSender } from '~/server/services/mailer'
import { authLimiters, clientIp, enforceRateLimit } from '~/server/services/rate-limit'

const BodySchema = z.object({ email: z.string().min(1).max(254) })

export async function handleForgotPassword(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown,
  deps: { mailer: MailSender; baseUrl: string }
): Promise<{ ok: true }> {
  const body = BodySchema.parse(rawBody)
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, body.email.toLowerCase()))
  if (u) {
    const token = await createResetToken(db, u.id)
    const resetUrl = `${deps.baseUrl}/reset-password?token=${token}`
    try {
      await deps.mailer.sendPasswordReset(u.email, resetUrl)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[forgot-password] mail send failed', e)
    }
  }
  // Always generic — never reveal whether the address exists.
  return { ok: true }
}

export default defineEventHandler(async (event) => {
  // Throttle reset-email sends per source and per target inbox (Resend abuse +
  // mailbox flooding). Keying on the submitted email — before any DB lookup —
  // keeps the response non-enumerating.
  enforceRateLimit(event, authLimiters.forgotIp, clientIp(event))
  const body = await readBody(event)
  const email =
    typeof (body as any)?.email === 'string' ? (body as any).email.toLowerCase() : null
  if (email) enforceRateLimit(event, authLimiters.forgotAccount, email)
  const config = useRuntimeConfig()
  try {
    return await handleForgotPassword(useDb(), body, {
      mailer: useMailer(),
      baseUrl: (config.mailBaseUrl as string) || ''
    })
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
