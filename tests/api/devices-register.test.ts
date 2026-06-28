import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleRegister } from '~/server/api/devices/register.post'
import { hashDeviceSecret } from '~/server/services/device-secret'
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
    expect(result).toMatchObject({
      deviceId: 'dev-abc',
      claimed: false,
      name: null,
      groupId: null
    })
    expect(typeof result.commandSecret).toBe('string')

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

  it('persists surface when provided', async () => {
    await handleRegister(db, { deviceId: 'dev-vs', playerVersion: '0.1.0', surface: 'native' })
    const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-vs'))
    expect(row.surface).toBe('native')
  })

  it('defaults surface to webview when omitted', async () => {
    await handleRegister(db, { deviceId: 'dev-wv', playerVersion: '0.1.0' })
    const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-wv'))
    expect(row.surface).toBe('webview')
  })

  it('issues a command secret once (TOFU) and stores only its hash', async () => {
    const r1 = await handleRegister(db, { deviceId: 'dev-s', playerVersion: '1' })
    expect(typeof r1.commandSecret).toBe('string')
    const [row1] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-s'))
    expect(row1.commandSecret).toBe(hashDeviceSecret(r1.commandSecret!))
    expect(row1.commandSecretActive).toBe(false)

    // Second register must NOT re-issue or rotate the secret (so an attacker who
    // knows the deviceId can't re-bootstrap it).
    const r2 = await handleRegister(db, { deviceId: 'dev-s', playerVersion: '2' })
    expect(r2.commandSecret).toBeNull()
    const [row2] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-s'))
    expect(row2.commandSecret).toBe(row1.commandSecret)
  })
})
