import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedDevice } from '../helpers/fixtures'
import * as schema from '~/server/db/schema'
import { CommandHub } from '~/server/services/command-hub'

function makePeer() {
  const sent: string[] = []
  return {
    send: (msg: string) => sent.push(msg),
    sent
  }
}

describe('CommandHub', () => {
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

  it('enqueue inserts pending row when device is offline', async () => {
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('pending')
    expect(row.cmd).toBe('screenshot')
  })

  it('enqueue sends immediately and marks sent when device is online', async () => {
    const peer = makePeer()
    hub.register('dev-1', peer)
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    expect(peer.sent).toHaveLength(1)
    expect(JSON.parse(peer.sent[0])).toMatchObject({ commandId: id, cmd: 'screenshot' })
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('sent')
  })

  it('enqueue marks reboot acked immediately on delivery (no ack from device)', async () => {
    const peer = makePeer()
    hub.register('dev-1', peer)
    const id = await hub.enqueue(db, 'dev-1', 'reboot', null)
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('acked')
  })

  it('drain sends all pending commands to peer', async () => {
    await hub.enqueue(db, 'dev-1', 'screenshot', null)
    await hub.enqueue(db, 'dev-1', 'log-request', null)
    const peer = makePeer()
    hub.register('dev-1', peer)
    await hub.drain(db, 'dev-1', peer)
    expect(peer.sent).toHaveLength(2)
    const [cmd1, cmd2] = await db.select().from(schema.deviceCommands)
    expect(cmd1.status).toBe('sent')
    expect(cmd2.status).toBe('sent')
  })

  it('handleAck updates row status and result', async () => {
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    // simulate device is online so it was sent
    const peer = makePeer()
    hub.register('dev-1', peer)
    await hub.enqueue(db, 'dev-1', 'screenshot', null) // fresh one that goes to sent
    await hub.handleAck(db, 'dev-1', id, 'acked', 'data:image/jpeg;base64,abc')
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('acked')
    expect(row.result).toBe('data:image/jpeg;base64,abc')
  })

  it('handleAck ignores acks for a command that belongs to another device', async () => {
    await seedDevice(db, { id: 'dev-2' })
    // A command queued for dev-1 (dev-1 offline → stays pending).
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)

    // dev-2 (an attacker socket) tries to ack/spoof dev-1's command by id.
    await hub.handleAck(db, 'dev-2', id, 'failed', 'spoofed')
    const [tampered] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(tampered.status).toBe('pending') // untouched
    expect(tampered.result).toBeNull()

    // The real owner can still ack it.
    await hub.handleAck(db, 'dev-1', id, 'acked', 'ok')
    const [owned] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(owned.status).toBe('acked')
    expect(owned.result).toBe('ok')
  })

  it('onDisconnect re-queues sent commands to pending', async () => {
    const peer = makePeer()
    hub.register('dev-1', peer)
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    const [before] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(before.status).toBe('sent')

    await hub.onDisconnect(db, 'dev-1', peer)

    const [after] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(after.status).toBe('pending')
    expect(hub.isConnected('dev-1')).toBe(false)
  })

  it('onDisconnect from a superseded peer does not disturb the live connection', async () => {
    // A reconnect: a new socket (peerB) registers before the old one's (peerA)
    // close event fires. The stale close must NOT delete peerB or revert the
    // commands peerB already received.
    const peerA = makePeer()
    hub.register('dev-1', peerA)
    const peerB = makePeer()
    hub.register('dev-1', peerB)

    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null) // delivered to peerB → 'sent'
    expect(peerB.sent).toHaveLength(1)
    expect(peerA.sent).toHaveLength(0)

    await hub.onDisconnect(db, 'dev-1', peerA) // stale close — no-op

    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('sent') // not reverted
    expect(hub.isConnected('dev-1')).toBe(true) // peerB still live
  })
})
