import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedUser } from '../helpers/fixtures'

describe('auth schema', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates an organization and a client user linked to it', async () => {
    const org = await seedOrganization(db)
    const u = await seedUser(db, { email: 'c1', role: 'client', organizationId: org.id })
    expect(u.role).toBe('client')
    expect(u.organizationId).toBe(org.id)
  })

  it('allows super/admin without an organization', async () => {
    const s = await seedUser(db, { email: 'super', role: 'super' })
    expect(s.organizationId).toBeNull()
  })

  it('rejects a client without an organization (CHECK constraint)', async () => {
    await expect(
      seedUser(db, { email: 'bad', role: 'client', organizationId: null })
    ).rejects.toThrow()
  })

  it('rejects a super WITH an organization (CHECK constraint)', async () => {
    const org = await seedOrganization(db)
    await expect(
      seedUser(db, { email: 'bad2', role: 'super', organizationId: org.id })
    ).rejects.toThrow()
  })

  it('enforces unique emails', async () => {
    await seedUser(db, { email: 'dup', role: 'admin' })
    await expect(seedUser(db, { email: 'dup', role: 'admin' })).rejects.toThrow()
  })
})
