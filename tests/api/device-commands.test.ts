import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedDevice } from '../helpers/fixtures'
import * as schema from '~/server/db/schema'
import { CommandHub } from '~/server/services/command-hub'
import { handleEnqueueCommand, handleListCommands } from '~/server/api/devices/[id]/commands.post'

describe('device commands API', () => {
  let db: TestDb
  let close: () => void
  let hub: CommandHub

  beforeEach(async () => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new CommandHub()
    await seedDevice(db, { id: 'dev-1' })
  })
  afterEach(() => close())

  it('enqueue screenshot command returns commandId', async () => {
    const result = await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'screenshot' })
    expect(result.commandId).toBeTypeOf('number')
  })

  it('enqueue ota command requires releaseId', async () => {
    const [rel] = await db
      .insert(schema.apkReleases)
      .values({ version: '1.0', sha256: 'a'.repeat(64), size: 100 })
      .returning()
    const result = await handleEnqueueCommand(db, hub, 'dev-1', {
      cmd: 'ota',
      releaseId: rel.id
    })
    expect(result.commandId).toBeTypeOf('number')
  })

  it('enqueue ota 400s on missing releaseId', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota' })
    ).rejects.toThrow(/releaseId/i)
  })

  it('enqueue 404s on unknown device', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'ghost', { cmd: 'screenshot' })
    ).rejects.toThrow(/not found/i)
  })

  it('list returns recent commands newest first', async () => {
    await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'screenshot' })
    await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'log-request' })
    const list = await handleListCommands(db, 'dev-1')
    expect(list).toHaveLength(2)
    expect(list[0].cmd).toBe('log-request')
  })
})
