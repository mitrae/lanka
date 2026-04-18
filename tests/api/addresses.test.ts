import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedAddress, seedGroup } from '../helpers/fixtures'
import {
  handleListAddresses,
  handleCreateAddress
} from '~/server/api/addresses/index.post'
import {
  handleGetAddress,
  handleUpdateAddress,
  handleDeleteAddress
} from '~/server/api/addresses/[id].delete'
import * as schema from '~/server/db/schema'

describe('addresses CRUD', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('list returns all addresses ordered by created_at', async () => {
    const a = await seedAddress(db, 'First')
    await new Promise((r) => setTimeout(r, 5))
    const b = await seedAddress(db, 'Second')

    const rows = await handleListAddresses(db)
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
  })

  it('create inserts and returns the row', async () => {
    const row = await handleCreateAddress(db, { name: 'New' })
    expect(row.name).toBe('New')
    expect(row.id).toBeGreaterThan(0)

    const all = await db.select().from(schema.addresses)
    expect(all).toHaveLength(1)
  })

  it('create rejects empty name', async () => {
    await expect(handleCreateAddress(db, { name: '' })).rejects.toThrow()
  })

  it('get returns the row', async () => {
    const a = await seedAddress(db, 'X')
    const row = await handleGetAddress(db, a.id)
    expect(row.name).toBe('X')
  })

  it('get 404s on unknown id', async () => {
    await expect(handleGetAddress(db, 9999)).rejects.toThrow(/not found/i)
  })

  it('update changes name and bumps updatedAt', async () => {
    const a = await seedAddress(db, 'Before')
    await new Promise((r) => setTimeout(r, 5))
    const updated = await handleUpdateAddress(db, a.id, { name: 'After' })
    expect(updated.name).toBe('After')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime())
  })

  it('update 404s on unknown id', async () => {
    await expect(
      handleUpdateAddress(db, 9999, { name: 'x' })
    ).rejects.toThrow(/not found/i)
  })

  it('delete cascades to groups', async () => {
    const a = await seedAddress(db)
    await seedGroup(db, a.id, 'G')
    await handleDeleteAddress(db, a.id)

    expect(await db.select().from(schema.addresses)).toHaveLength(0)
    expect(await db.select().from(schema.groups)).toHaveLength(0)
  })

  it('delete 404s on unknown id', async () => {
    await expect(handleDeleteAddress(db, 9999)).rejects.toThrow(/not found/i)
  })
})
