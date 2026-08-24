import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedUser } from '../helpers/fixtures'
import { handleListOrganizations } from '~/server/api/organizations/index.get'
import { handleCreateOrganization } from '~/server/api/organizations/index.post'
import { handleGetOrganization } from '~/server/api/organizations/[id].get'
import { handleUpdateOrganization } from '~/server/api/organizations/[id].patch'
import { handleDeleteOrganization } from '~/server/api/organizations/[id].delete'

describe('organizations API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates and lists organizations alphabetically', async () => {
    await handleCreateOrganization(db, { name: 'Zeta' })
    await handleCreateOrganization(db, { name: 'Alpha' })
    const list = await handleListOrganizations(db)
    expect(list.map((o) => o.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('rejects an empty name', async () => {
    await expect(handleCreateOrganization(db, { name: '' })).rejects.toThrow()
  })

  it('stores the contact fields on create', async () => {
    const org = await handleCreateOrganization(db, {
      name: 'Acme',
      phone: '+380 44 123 45 67',
      email: 'ads@acme.example',
      notes: 'Pays quarterly.'
    })
    expect(org).toMatchObject({
      name: 'Acme',
      phone: '+380 44 123 45 67',
      email: 'ads@acme.example',
      notes: 'Pays quarterly.'
    })
  })

  it('normalises blank contact fields to null', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme', phone: '  ', email: '', notes: '' })
    expect(org.phone).toBeNull()
    expect(org.email).toBeNull()
    expect(org.notes).toBeNull()
  })

  it('rejects a malformed email', async () => {
    await expect(handleCreateOrganization(db, { name: 'Acme', email: 'nope' })).rejects.toThrow()
  })

  it('returns zeroed counts on create, so the row matches a listed one', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme' })
    expect(org).toMatchObject({ mediaCount: 0, userCount: 0 })
  })

  it('lists usage counts per organization', async () => {
    const acme = await handleCreateOrganization(db, { name: 'Acme' })
    await handleCreateOrganization(db, { name: 'Beta' })
    await seedMedia(db, { sha256: 'a'.repeat(64), kind: 'video', filename: 'a.mp4', organizationId: acme.id })
    await seedMedia(db, { sha256: 'b'.repeat(64), kind: 'video', filename: 'b.mp4', organizationId: acme.id })
    await seedUser(db, { email: 'c@acme.example', role: 'client', organizationId: acme.id })

    const list = await handleListOrganizations(db)
    expect(list.find((o) => o.name === 'Acme')).toMatchObject({ mediaCount: 2, userCount: 1 })
    expect(list.find((o) => o.name === 'Beta')).toMatchObject({ mediaCount: 0, userCount: 0 })
  })

  it('reads one organization with its counts', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme' })
    await seedMedia(db, { sha256: 'a'.repeat(64), kind: 'video', filename: 'a.mp4', organizationId: org.id })
    const row = await handleGetOrganization(db, org.id)
    expect(row).toMatchObject({ id: org.id, name: 'Acme', mediaCount: 1, userCount: 0 })
  })

  it('404s on an unknown organization', async () => {
    await expect(handleGetOrganization(db, 999)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('updates only the supplied fields', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme', phone: '123', notes: 'keep me' })
    const updated = await handleUpdateOrganization(db, org.id, { name: 'Acme Ads', email: 'x@acme.example' })
    expect(updated).toMatchObject({
      name: 'Acme Ads',
      phone: '123',
      email: 'x@acme.example',
      notes: 'keep me'
    })
  })

  it('clears a field when it is set to null or blank', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme', phone: '123', notes: 'bye' })
    const updated = await handleUpdateOrganization(db, org.id, { phone: null, notes: '' })
    expect(updated.phone).toBeNull()
    expect(updated.notes).toBeNull()
  })

  it('rejects an update that would blank the name', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme' })
    await expect(handleUpdateOrganization(db, org.id, { name: '   ' })).rejects.toThrow()
  })

  it('404s when updating an unknown organization', async () => {
    await expect(handleUpdateOrganization(db, 999, { name: 'Nope' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('deletes an unused organization', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme' })
    await handleDeleteOrganization(db, org.id, {})
    expect(await handleListOrganizations(db)).toEqual([])
  })

  it('404s when deleting an unknown organization', async () => {
    await expect(handleDeleteOrganization(db, 999, {})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses to delete an organization that still owns media or users', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme' })
    await seedMedia(db, { sha256: 'a'.repeat(64), kind: 'video', filename: 'a.mp4', organizationId: org.id })
    await expect(handleDeleteOrganization(db, org.id, {})).rejects.toMatchObject({ statusCode: 409 })
  })

  it('force-deletes: media is detached, client accounts go with the organization', async () => {
    const org = await handleCreateOrganization(db, { name: 'Acme' })
    const m = await seedMedia(db, { sha256: 'a'.repeat(64), kind: 'video', filename: 'a.mp4', organizationId: org.id })
    await seedUser(db, { email: 'c@acme.example', role: 'client', organizationId: org.id })

    await handleDeleteOrganization(db, org.id, { force: true })

    expect(await handleListOrganizations(db)).toEqual([])
    const media = await db.query.media.findFirst({ where: (t, { eq }) => eq(t.id, m.id) })
    expect(media?.organizationId).toBeNull()
    const users = await db.query.users.findMany()
    expect(users).toEqual([])
  })
})
