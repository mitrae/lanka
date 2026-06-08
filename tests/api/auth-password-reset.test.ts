import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import * as schema from '~/server/db/schema'
import { hashPassword, verifyPassword } from '~/server/services/password'
import { createSession, getSessionUser } from '~/server/services/sessions'
import { handleForgotPassword } from '~/server/api/auth/forgot-password.post'
import { handleResetPassword } from '~/server/api/auth/reset-password.post'
import type { MailSender } from '~/server/services/mailer'

class CaptureMailer implements MailSender {
  sent: Array<{ to: string; url: string }> = []
  async sendPasswordReset(to: string, url: string) { this.sent.push({ to, url }) }
}

describe('forgot/reset password', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('emails a reset link for a known address', async () => {
    await seedUser(db, { email: 'a@x', role: 'admin', passwordHash: await hashPassword('old') })
    const mailer = new CaptureMailer()
    const res = await handleForgotPassword(db, { email: 'a@x' }, { mailer, baseUrl: 'https://app.lanka.live' })
    expect(res).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].url).toMatch(/^https:\/\/app\.lanka\.live\/reset-password\?token=.+/)
  })

  it('does not reveal unknown addresses (still 200, no email)', async () => {
    const mailer = new CaptureMailer()
    const res = await handleForgotPassword(db, { email: 'ghost@x' }, { mailer, baseUrl: 'https://app.lanka.live' })
    expect(res).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(0)
  })

  it('resets the password, consumes the token, and kills sessions', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin', passwordHash: await hashPassword('old') })
    const sessionToken = await createSession(db, u.id)
    const mailer = new CaptureMailer()
    await handleForgotPassword(db, { email: 'a@x' }, { mailer, baseUrl: 'https://app' })
    const resetToken = new URL(mailer.sent[0].url).searchParams.get('token')!

    const res = await handleResetPassword(db, { token: resetToken, password: 'newpassword' })
    expect(res).toEqual({ ok: true })

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id))
    expect(await verifyPassword('newpassword', row.passwordHash)).toBe(true)
    expect(await getSessionUser(db, sessionToken)).toBeNull() // existing session invalidated
    await expect(handleResetPassword(db, { token: resetToken, password: 'another1' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a short password', async () => {
    await expect(handleResetPassword(db, { token: 'x', password: 'short' })).rejects.toBeTruthy()
  })
})
