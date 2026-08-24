import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedUser } from '../helpers/fixtures'
import { handleListUsers } from '~/server/api/users/index.get'
import { handleCreateUser } from '~/server/api/users/index.post'
import { handleDeleteUser } from '~/server/api/users/[id].delete'
import { handleGetUser } from '~/server/api/users/[id].get'
import { handleUpdateUser } from '~/server/api/users/[id].patch'
import { handleResetUserPassword } from '~/server/api/users/[id]/password.post'
import * as schema from '~/server/db/schema'
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

  it('stores the email lowercased', async () => {
    const result = await handleCreateUser(db, asSuper(), { email: 'Mixed.Case@Example.COM', role: 'admin' })
    expect(result.user.email).toBe('mixed.case@example.com')
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

describe('user update API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  async function seedClient(orgId: number, email = 'c@example.com') {
    return seedUser(db, { email, role: 'client', organizationId: orgId })
  }

  it('reads one user with its organization name', async () => {
    const org = await seedOrganization(db, 'Acme')
    const c = await seedClient(org.id)
    const row = await handleGetUser(db, asSuper(), c.id)
    expect(row).toMatchObject({ id: c.id, email: 'c@example.com', role: 'client', organizationName: 'Acme' })
  })

  it('404s on an unknown user', async () => {
    await expect(handleGetUser(db, asSuper(), 999)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('changes an email', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    const row = await handleUpdateUser(db, asSuper(), c.id, { email: 'Renamed@Example.COM' })
    expect(row.email).toBe('renamed@example.com')
  })

  it('rejects a duplicate email with 409', async () => {
    const org = await seedOrganization(db)
    await seedClient(org.id, 'taken@example.com')
    const c = await seedClient(org.id, 'other@example.com')
    await expect(
      handleUpdateUser(db, asSuper(), c.id, { email: 'taken@example.com' })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('moves a client to another organization', async () => {
    const a = await seedOrganization(db, 'Acme')
    const b = await seedOrganization(db, 'Beta')
    const c = await seedClient(a.id)
    const row = await handleUpdateUser(db, asSuper(), c.id, { organizationId: b.id })
    expect(row).toMatchObject({ organizationId: b.id, organizationName: 'Beta' })
  })

  it('rejects an unknown organization', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    await expect(
      handleUpdateUser(db, asSuper(), c.id, { organizationId: 999 })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('promoting a client to admin clears the organization', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    const row = await handleUpdateUser(db, asSuper(), c.id, { role: 'admin' })
    expect(row).toMatchObject({ role: 'admin', organizationId: null })
  })

  it('demoting an admin to client requires an organization', async () => {
    const a = await seedUser(db, { email: 'a@example.com', role: 'admin' })
    await expect(
      handleUpdateUser(db, asSuper(), a.id, { role: 'client' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('demoting an admin to client works when an organization is supplied', async () => {
    const org = await seedOrganization(db)
    const a = await seedUser(db, { email: 'a@example.com', role: 'admin' })
    const row = await handleUpdateUser(db, asSuper(), a.id, { role: 'client', organizationId: org.id })
    expect(row).toMatchObject({ role: 'client', organizationId: org.id })
  })

  it('refuses to clear a client organization', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    await expect(
      handleUpdateUser(db, asSuper(), c.id, { organizationId: null })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses to give an admin an organization', async () => {
    const org = await seedOrganization(db)
    const a = await seedUser(db, { email: 'a@example.com', role: 'admin' })
    await expect(
      handleUpdateUser(db, asSuper(), a.id, { organizationId: org.id })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('never touches a super account', async () => {
    const s = await seedUser(db, { email: 's@example.com', role: 'super' })
    await expect(
      handleUpdateUser(db, asSuper(), s.id, { email: 'x@example.com' })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an admin may edit a client but not another admin', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    const other = await seedUser(db, { email: 'a2@example.com', role: 'admin' })
    await expect(handleUpdateUser(db, asAdmin(), c.id, { email: 'ok@example.com' })).resolves.toMatchObject({
      email: 'ok@example.com'
    })
    await expect(
      handleUpdateUser(db, asAdmin(), other.id, { email: 'x@example.com' })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an admin may not promote a client to admin', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    await expect(
      handleUpdateUser(db, asAdmin(), c.id, { role: 'admin' })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects an empty patch', async () => {
    const org = await seedOrganization(db)
    const c = await seedClient(org.id)
    await expect(handleUpdateUser(db, asSuper(), c.id, {})).rejects.toThrow()
  })
})

describe('admin password reset API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('sets a new working password and returns it once', async () => {
    const org = await seedOrganization(db)
    const c = await seedUser(db, { email: 'c@example.com', role: 'client', organizationId: org.id })
    const res = await handleResetUserPassword(db, asSuper(), c.id)
    expect(res.generatedPassword.length).toBeGreaterThanOrEqual(12)
    const [row] = await db.query.users.findMany({ where: (u, { eq }) => eq(u.id, c.id) })
    expect(await verifyPassword(res.generatedPassword, row.passwordHash)).toBe(true)
  })

  it('drops every session that user had', async () => {
    const org = await seedOrganization(db)
    const c = await seedUser(db, { email: 'c@example.com', role: 'client', organizationId: org.id })
    await db.insert(schema.sessions).values({
      id: 'sha-of-token',
      userId: c.id,
      expiresAt: new Date(Date.now() + 60_000)
    })
    await handleResetUserPassword(db, asSuper(), c.id)
    expect(await db.query.sessions.findMany()).toEqual([])
  })

  it('refuses a super target and an admin target for an admin caller', async () => {
    const s = await seedUser(db, { email: 's@example.com', role: 'super' })
    const a = await seedUser(db, { email: 'a@example.com', role: 'admin' })
    await expect(handleResetUserPassword(db, asSuper(), s.id)).rejects.toMatchObject({ statusCode: 403 })
    await expect(handleResetUserPassword(db, asAdmin(), a.id)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('404s on an unknown user', async () => {
    await expect(handleResetUserPassword(db, asSuper(), 999)).rejects.toMatchObject({ statusCode: 404 })
  })
})
