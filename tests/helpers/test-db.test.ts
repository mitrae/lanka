// tests/helpers/test-db.test.ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from './test-db'
import * as schema from '~/server/db/schema'

describe('test-db helper', () => {
  it('creates a fresh in-memory DB with all tables', async () => {
    const { db, close } = createTestDb()
    try {
      const addresses = await db.select().from(schema.addresses)
      expect(addresses).toEqual([])
    } finally {
      close()
    }
  })
})
