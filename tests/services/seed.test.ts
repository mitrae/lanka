import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia } from '../helpers/fixtures'
import { seedInitialUsers } from '~/server/services/seed'
import { verifyPassword } from '~/server/services/password'

describe('seedInitialUsers', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates super, admin, client (+demo org) on first run', async () => {
    const creds = await seedInitialUsers(db, {
      super: 'spw', admin: 'apw', client: 'cpw'
    })
    expect(creds.map((c) => c.role).sort()).toEqual(['admin', 'client', 'super'])
    const users = await db.query.users.findMany()
    expect(users).toHaveLength(3)
    expect(users.map((u) => u.email).sort()).toEqual([
      'admin@lanka.live', 'client@lanka.live', 'super@lanka.live'
    ])
    const client = users.find((u) => u.role === 'client')!
    expect(client.organizationId).not.toBeNull()
    expect(await verifyPassword('apw', users.find((u) => u.role === 'admin')!.passwordHash)).toBe(true)
  })

  it('assigns pre-existing unowned media to the demo org', async () => {
    await seedMedia(db, { sha256: 'm1', kind: 'image' })
    await seedInitialUsers(db, { super: 's', admin: 'a', client: 'c' })
    const [org] = await db.query.organizations.findMany()
    const media = await db.query.media.findMany()
    expect(media[0].organizationId).toBe(org.id)
  })

  it('is idempotent: a second run creates nothing and returns []', async () => {
    await seedInitialUsers(db, { super: 's', admin: 'a', client: 'c' })
    const second = await seedInitialUsers(db, { super: 's', admin: 'a', client: 'c' })
    expect(second).toEqual([])
    expect(await db.query.users.findMany()).toHaveLength(3)
  })

  it('generates a random password and flags it when env is missing', async () => {
    const creds = await seedInitialUsers(db, {})
    expect(creds.every((c) => c.generated)).toBe(true)
    expect(creds.every((c) => c.password.length >= 12)).toBe(true)
  })
})
