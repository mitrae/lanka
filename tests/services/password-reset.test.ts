import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { createResetToken, consumeResetToken, RESET_TTL_MS } from '~/server/services/password-reset'

describe('password reset tokens', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('issues a token that consumes once to the right user', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin' })
    const token = await createResetToken(db, u.id)
    expect(await consumeResetToken(db, token)).toBe(u.id)
    // single-use: second consume fails
    expect(await consumeResetToken(db, token)).toBeNull()
  })

  it('rejects an unknown token', async () => {
    expect(await consumeResetToken(db, 'nope')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin' })
    const past = new Date(Date.now() - RESET_TTL_MS - 1000)
    const token = await createResetToken(db, u.id, past)
    expect(await consumeResetToken(db, token)).toBeNull()
  })

  it('stores only a hash of the token (raw token absent from the row id)', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin' })
    const token = await createResetToken(db, u.id)
    const rows = await db.query.passwordResetTokens.findMany()
    expect(rows[0].id).not.toEqual(token)
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/)
  })
})
