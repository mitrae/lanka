import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleRegister } from '~/server/api/devices/register.post'
import * as schema from '~/server/db/schema'

describe('POST /api/devices/register handler', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('creates a new unclaimed device row on first call', async () => {
    const result = await handleRegister(db, {
      deviceId: 'dev-abc',
      playerVersion: '0.1.0'
    })
    expect(result).toEqual({
      deviceId: 'dev-abc',
      claimed: false,
      name: null,
      groupId: null
    })

    const [row] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-abc'))
    expect(row.playerVersion).toBe('0.1.0')
    expect(row.groupId).toBeNull()
    expect(row.lastSeenAt).toBeInstanceOf(Date)
  })

  it('is idempotent — second call updates lastSeenAt + playerVersion', async () => {
    await handleRegister(db, { deviceId: 'dev-abc', playerVersion: '0.1.0' })
    await new Promise((r) => setTimeout(r, 10))
    await handleRegister(db, { deviceId: 'dev-abc', playerVersion: '0.2.0' })

    const [row] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-abc'))
    expect(row.playerVersion).toBe('0.2.0')
  })

  it('reports claimed: true when device has a groupId', async () => {
    const [addr] = await db
      .insert(schema.addresses)
      .values({ name: 'A' })
      .returning()
    const [grp] = await db
      .insert(schema.groups)
      .values({ addressId: addr.id, name: 'G' })
      .returning()
    await db
      .insert(schema.devices)
      .values({ id: 'dev-claimed', groupId: grp.id, name: 'TV-1' })

    const result = await handleRegister(db, {
      deviceId: 'dev-claimed',
      playerVersion: '0.1.0'
    })
    expect(result.claimed).toBe(true)
    expect(result.name).toBe('TV-1')
    expect(result.groupId).toBe(grp.id)
  })

  it('rejects body with missing deviceId', async () => {
    await expect(
      handleRegister(db, { deviceId: '', playerVersion: '0.1.0' } as any)
    ).rejects.toThrow(/deviceId/)
  })

  it('rejects deviceId longer than 128 chars', async () => {
    const big = 'x'.repeat(129)
    await expect(
      handleRegister(db, { deviceId: big, playerVersion: '0.1.0' })
    ).rejects.toThrow()
  })
})
