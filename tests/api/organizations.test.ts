import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleListOrganizations } from '~/server/api/organizations/index.get'
import { handleCreateOrganization } from '~/server/api/organizations/index.post'

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
})
