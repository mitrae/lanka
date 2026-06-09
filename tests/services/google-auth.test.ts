import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { handleGoogleLogin } from '~/server/api/auth/google.post'
import { getSessionUser } from '~/server/services/sessions'
import type { GoogleIdentity } from '~/server/services/google-auth'

const CLIENT_ID = 'test-cid.apps.googleusercontent.com'

// Build a stub verify fn that returns a fixed identity (or null).
function stubVerify(identity: GoogleIdentity | null) {
  return async (_idToken: string, _clientId: string) => identity
}

describe('handleGoogleLogin', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates a session for a verified email matching an existing user', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'admin@lanka.live', emailVerified: true }), clientId: CLIENT_ID }
    )
    expect(result).not.toBeNull()
    expect(result!.user.email).toBe('admin@lanka.live')
    expect(result!.user.role).toBe('admin')
    expect(await getSessionUser(db, result!.token)).toMatchObject({ email: 'admin@lanka.live' })
  })

  it('matches case-insensitively (token email in mixed case)', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'Admin@Lanka.LIVE', emailVerified: true }), clientId: CLIENT_ID }
    )
    expect(result).not.toBeNull()
    expect(result!.user.email).toBe('admin@lanka.live')
  })

  it('returns null when no user matches the verified email', async () => {
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'ghost@lanka.live', emailVerified: true }), clientId: CLIENT_ID }
    )
    expect(result).toBeNull()
  })

  it('returns null when the email is not verified', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'admin@lanka.live', emailVerified: false }), clientId: CLIENT_ID }
    )
    expect(result).toBeNull()
  })

  it('returns null when token verification fails (verify returns null)', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify(null), clientId: CLIENT_ID }
    )
    expect(result).toBeNull()
  })

  it('returns null when sign-in is disabled (empty clientId)', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'admin@lanka.live', emailVerified: true }), clientId: '' }
    )
    expect(result).toBeNull()
  })

  it('throws a ZodError for a malformed body (no credential)', async () => {
    await expect(
      handleGoogleLogin(db, {}, { verify: stubVerify(null), clientId: CLIENT_ID })
    ).rejects.toThrow()
  })
})
