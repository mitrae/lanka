import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { hashPassword } from '~/server/services/password'
import { authenticateUser, sessionCookieOptions } from '~/server/api/auth/login.post'
import { getSessionUser, SESSION_TTL_MS } from '~/server/services/sessions'

describe('authenticateUser', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('returns a user + valid session token for correct credentials', async () => {
    await seedUser(db, { email: 'admin', role: 'admin', passwordHash: await hashPassword('pw') })
    const result = await authenticateUser(db, { email: 'admin', password: 'pw' })
    expect(result).not.toBeNull()
    expect(result!.user.email).toBe('admin')
    expect(await getSessionUser(db, result!.token)).toMatchObject({ email: 'admin' })
  })

  it('returns null for a wrong password', async () => {
    await seedUser(db, { email: 'admin', role: 'admin', passwordHash: await hashPassword('pw') })
    expect(await authenticateUser(db, { email: 'admin', password: 'nope' })).toBeNull()
  })

  it('returns null for an unknown user', async () => {
    expect(await authenticateUser(db, { email: 'ghost', password: 'x' })).toBeNull()
  })
})

describe('sessionCookieOptions', () => {
  it('marks the cookie Secure when asked (public HTTPS prod)', () => {
    expect(sessionCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
      secure: true
    })
  })

  it('leaves the cookie insecure for plain-http dev/tailnet', () => {
    expect(sessionCookieOptions(false).secure).toBe(false)
  })
})
