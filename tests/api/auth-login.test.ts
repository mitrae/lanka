import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { hashPassword } from '~/server/services/password'
import { authenticateUser } from '~/server/api/auth/login.post'
import { getSessionUser } from '~/server/services/sessions'

describe('authenticateUser', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('returns a user + valid session token for correct credentials', async () => {
    await seedUser(db, { username: 'admin', role: 'admin', passwordHash: await hashPassword('pw') })
    const result = await authenticateUser(db, { username: 'admin', password: 'pw' })
    expect(result).not.toBeNull()
    expect(result!.user.username).toBe('admin')
    expect(await getSessionUser(db, result!.token)).toMatchObject({ username: 'admin' })
  })

  it('returns null for a wrong password', async () => {
    await seedUser(db, { username: 'admin', role: 'admin', passwordHash: await hashPassword('pw') })
    expect(await authenticateUser(db, { username: 'admin', password: 'nope' })).toBeNull()
  })

  it('returns null for an unknown user', async () => {
    expect(await authenticateUser(db, { username: 'ghost', password: 'x' })).toBeNull()
  })
})
