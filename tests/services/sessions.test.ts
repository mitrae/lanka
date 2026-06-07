import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import {
  createSession,
  getSessionUser,
  deleteSession,
  SESSION_TTL_MS
} from '~/server/services/sessions'

describe('sessions', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('round-trips a session token to a user', async () => {
    const u = await seedUser(db, { username: 'admin', role: 'admin' })
    const token = await createSession(db, u.id)
    const su = await getSessionUser(db, token)
    expect(su).toMatchObject({ id: u.id, username: 'admin', role: 'admin', organizationId: null })
  })

  it('returns null for an unknown / undefined token', async () => {
    expect(await getSessionUser(db, undefined)).toBeNull()
    expect(await getSessionUser(db, 'nope')).toBeNull()
  })

  it('returns null for an expired session', async () => {
    const u = await seedUser(db, { username: 'a', role: 'admin' })
    const past = new Date(Date.now() - SESSION_TTL_MS - 1000)
    const token = await createSession(db, u.id, past) // expires relative to `past`
    expect(await getSessionUser(db, token)).toBeNull()
  })

  it('deleteSession invalidates the token', async () => {
    const u = await seedUser(db, { username: 'a', role: 'admin' })
    const token = await createSession(db, u.id)
    await deleteSession(db, token)
    expect(await getSessionUser(db, token)).toBeNull()
  })

  it('stores only a hash of the token (raw token absent from the row id)', async () => {
    const u = await seedUser(db, { username: 'a', role: 'admin' })
    const token = await createSession(db, u.id)
    const rows = await db.query.sessions.findMany()
    expect(rows[0].id).not.toEqual(token)
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/)
  })
})
