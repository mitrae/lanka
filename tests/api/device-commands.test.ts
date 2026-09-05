import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
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

  describe('ota downgrade guard', () => {
    async function release(version: string, versionCode: number | null, sha: string) {
      const [r] = await db.insert(schema.apkReleases)
        .values({ version, versionCode, sha256: sha.repeat(64), size: 1 }).returning()
      return r
    }
    async function boxRuns(apkVersion: string | null) {
      await db.update(schema.devices).set({ apkVersion }).where(eq(schema.devices.id, 'dev-1'))
    }

    it('409s when the box already runs the same or a newer versionCode', async () => {
      await release('0.5.0', 3, 'a'); await boxRuns('0.5.0')
      const same = await release('0.5.0-rebuild', 3, 'b')
      const older = await release('0.4.0', 2, 'c')
      await expect(handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: same.id }))
        .rejects.toMatchObject({ statusCode: 409 })
      await expect(handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: older.id }))
        .rejects.toMatchObject({ statusCode: 409 })
    })

    it('allows a newer versionCode', async () => {
      await release('0.5.0', 3, 'a'); await boxRuns('0.5.0')
      const newer = await release('0.6.0', 4, 'b')
      const r = await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: newer.id })
      expect(r.commandId).toBeTypeOf('number')
    })

    it('matches the box version against suffixed labels and picks the highest code', async () => {
      await release('0.5.0', 3, 'a'); await release('0.5.0-hotfix', 4, 'b'); await boxRuns('0.5.0')
      const code4 = await release('0.5.1', 4, 'c')
      await expect(handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: code4.id }))
        .rejects.toMatchObject({ statusCode: 409 })
    })

    it('never blocks when the box version is unknown here, or codes are missing', async () => {
      const target = await release('0.5.0', 3, 'a')
      await boxRuns('0.4.0-visibility') // sideloaded, never uploaded
      expect((await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: target.id })).commandId).toBeTypeOf('number')
      await boxRuns(null)
      expect((await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: target.id })).commandId).toBeTypeOf('number')
      const legacy = await release('0.3.0', null, 'd'); await boxRuns('0.5.0') // pre-manifest row
      expect((await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: legacy.id })).commandId).toBeTypeOf('number')
    })

    it('force overrides the guard', async () => {
      await release('0.5.0', 3, 'a'); await boxRuns('0.5.0')
      const older = await release('0.4.0', 2, 'b')
      const r = await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota', releaseId: older.id, force: true })
      expect(r.commandId).toBeTypeOf('number')
    })
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

  it('enqueue set-surface stores the surface in the payload', async () => {
    const result = await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface', surface: 'native' })
    const [row] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, result.commandId))
    expect(row.cmd).toBe('set-surface')
    expect(JSON.parse(row.payload!)).toEqual({ surface: 'native' })
  })

  it('enqueue set-surface 400s without a surface', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('enqueue 400s on an unknown surface', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface', surface: 'desktop' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('enqueue 400s on an unknown cmd', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'self-destruct' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('delivers set-surface with its payload to a connected peer', async () => {
    const sent: string[] = []
    hub.register('dev-1', { send: (m) => sent.push(m) })
    await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface', surface: 'webview' })
    expect(JSON.parse(sent[0])).toMatchObject({ cmd: 'set-surface', payload: { surface: 'webview' } })
  })
})
