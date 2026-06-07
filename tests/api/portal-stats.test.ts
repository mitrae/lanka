import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedMedia } from '../helpers/fixtures'
import { handlePortalStats } from '~/server/api/portal/stats.get'

describe('handlePortalStats', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('returns reach for the user\'s own org', async () => {
    const org = await seedOrganization(db, 'Mine')
    await seedMedia(db, { sha256: 'a', kind: 'image', organizationId: org.id })
    const res = await handlePortalStats(db, { id: 1, username: 'c', role: 'client', organizationId: org.id })
    expect(res.organization.name).toBe('Mine')
    expect(res.totals.mediaCount).toBe(1)
  })

  it('throws 400 when the client has no organization', async () => {
    await expect(
      handlePortalStats(db, { id: 1, username: 'c', role: 'client', organizationId: null })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 404 when the linked organization does not exist', async () => {
    await expect(
      handlePortalStats(db, { id: 1, username: 'c', role: 'client', organizationId: 999 })
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
