import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { createResetToken } from '~/server/services/password-reset'
import { useMailer, type MailSender } from '~/server/services/mailer'

const BodySchema = z.object({ email: z.string().min(1).max(254) })

export async function handleForgotPassword(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown,
  deps: { mailer: MailSender; baseUrl: string }
): Promise<{ ok: true }> {
  const body = BodySchema.parse(rawBody)
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, body.email))
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
  const body = await readBody(event)
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
