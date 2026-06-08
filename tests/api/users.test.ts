import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedUser } from '../helpers/fixtures'
import { handleListUsers } from '~/server/api/users/index.get'
import { handleCreateUser } from '~/server/api/users/index.post'
import { handleDeleteUser } from '~/server/api/users/[id].delete'
import { verifyPassword } from '~/server/services/password'
import type { SessionUser } from '~/server/services/sessions'

const asSuper = (id = 1): SessionUser => ({ id, email: 'super@example.com', role: 'super', organizationId: null })
const asAdmin = (id = 2): SessionUser => ({ id, email: 'admin@example.com', role: 'admin', organizationId: null })

describe('user management API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('super creates an admin and gets a one-time password back', async () => {
    const res = await handleCreateUser(db, asSuper(), { email: 'new-admin@example.com', role: 'admin' })
    expect(res.user).toMatchObject({ email: 'new-admin@example.com', role: 'admin', organizationId: null })
    expect(res.generatedPassword.length).toBeGreaterThanOrEqual(12)
    const [row] = await db.query.users.findMany({ where: (u, { eq }) => eq(u.email, 'new-admin@example.com') })
    expect(await verifyPassword(res.generatedPassword, row.passwordHash)).toBe(true)
  })

  it('super creates a client bound to an org', async () => {
    const org = await seedOrganization(db)
    const res = await handleCreateUser(db, asSuper(), { email: 'client1@example.com', role: 'client', organizationId: org.id })
    expect(res.user).toMatchObject({ role: 'client', organizationId: org.id })
  })

  it('rejects a client without an org (400)', async () => {
    await expect(handleCreateUser(db, asSuper(), { email: 'client2@example.com', role: 'client' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an admin given an org (400)', async () => {
    const org = await seedOrganization(db)
    await expect(handleCreateUser(db, asSuper(), { email: 'admin2@example.com', role: 'admin', organizationId: org.id }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('admin may create a client but not an admin (403)', async () => {
    const org = await seedOrganization(db)
    await expect(handleCreateUser(db, asAdmin(), { email: 'ok-client@example.com', role: 'client', organizationId: org.id }))
      .resolves.toBeTruthy()
    await expect(handleCreateUser(db, asAdmin(), { email: 'no-admin@example.com', role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a duplicate email (409)', async () => {
    await handleCreateUser(db, asSuper(), { email: 'dup@example.com', role: 'admin' })
    await expect(handleCreateUser(db, asSuper(), { email: 'dup@example.com', role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects a malformed email (400)', async () => {
    await expect(handleCreateUser(db, asSuper(), { email: 'not-an-email', role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('admin sees only clients; super sees everyone', async () => {
    const org = await seedOrganization(db)
    await seedUser(db, { email: 'admin1@example.com', role: 'admin' })
    await seedUser(db, { email: 'client3@example.com', role: 'client', organizationId: org.id })
    const adminView = await handleListUsers(db, asAdmin())
    expect(adminView.every((u) => u.role === 'client')).toBe(true)
    const superView = await handleListUsers(db, asSuper())
    expect(superView.some((u) => u.role === 'admin')).toBe(true)
    expect(superView.find((u) => u.role === 'client')?.organizationName).toBe(org.name)
  })

  it('delete: blocks self, super targets, admin→admin, and allows super→client + super→admin', async () => {
    const org = await seedOrganization(db)
    const adminRow = await seedUser(db, { email: 'me@example.com', role: 'admin' })
    const superRow = await seedUser(db, { email: 'boss@example.com', role: 'super' })
    const otherAdmin = await seedUser(db, { email: 'other-admin@example.com', role: 'admin' })
    const clientRow = await seedUser(db, { email: 'cli@example.com', role: 'client', organizationId: org.id })

    const adminCaller: SessionUser = { id: adminRow.id, email: 'me@example.com', role: 'admin', organizationId: null }
    // self
    await expect(handleDeleteUser(db, adminCaller, adminRow.id)).rejects.toMatchObject({ statusCode: 403 })
    // super target (super deleting a super)
    await expect(handleDeleteUser(db, asSuper(), superRow.id)).rejects.toMatchObject({ statusCode: 403 })
    // admin deleting another (non-super) admin → admins may only delete clients
    await expect(handleDeleteUser(db, adminCaller, otherAdmin.id)).rejects.toMatchObject({ statusCode: 403 })
    // allowed: super deletes a client
    await handleDeleteUser(db, asSuper(), clientRow.id)
    const remaining = await db.query.users.findMany({ where: (u, { eq }) => eq(u.id, clientRow.id) })
    expect(remaining).toHaveLength(0)
    // allowed: super deletes an admin
    await handleDeleteUser(db, asSuper(), otherAdmin.id)
    const adminGone = await db.query.users.findMany({ where: (u, { eq }) => eq(u.id, otherAdmin.id) })
    expect(adminGone).toHaveLength(0)
  })

  it('delete: 404 for a missing user', async () => {
    await expect(handleDeleteUser(db, asSuper(), 9999)).rejects.toMatchObject({ statusCode: 404 })
  })
})
