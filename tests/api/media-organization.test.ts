import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedOrganization } from '../helpers/fixtures'
import { handleAssignMediaOrg } from '~/server/api/media/[id]/organization.put'

describe('handleAssignMediaOrg', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('assigns and unassigns media ownership', async () => {
    const org = await seedOrganization(db)
    const m = await seedMedia(db, { sha256: 'a', kind: 'image' })
    const assigned = await handleAssignMediaOrg(db, m.id, { organizationId: org.id })
    expect(assigned.organizationId).toBe(org.id)
    const cleared = await handleAssignMediaOrg(db, m.id, { organizationId: null })
    expect(cleared.organizationId).toBeNull()
  })

  it('404s unknown media', async () => {
    await expect(handleAssignMediaOrg(db, 999, { organizationId: null })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s an unknown organization', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'image' })
    await expect(handleAssignMediaOrg(db, m.id, { organizationId: 777 })).rejects.toMatchObject({ statusCode: 400 })
  })
})
