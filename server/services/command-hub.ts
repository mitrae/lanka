import { eq, and } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

export type CommandStatus = 'pending' | 'sent' | 'acked' | 'failed'
export type CommandType = 'ota' | 'reboot' | 'screenshot' | 'log-request' | 'kiosk-lock' | 'kiosk-unlock' | 'set-surface'

interface Peer {
  send(msg: string): void
}

export class CommandHub {
  private peers = new Map<string, Peer>()

  register(deviceId: string, peer: Peer): void {
    this.peers.set(deviceId, peer)
  }

  isConnected(deviceId: string): boolean {
    return this.peers.has(deviceId)
  }

  private send(deviceId: string, msg: object): boolean {
    const peer = this.peers.get(deviceId)
    if (!peer) return false
    peer.send(JSON.stringify(msg))
    return true
  }

  async enqueue(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string,
    cmd: CommandType,
    payload: Record<string, unknown> | null
  ): Promise<number> {
    const [row] = await db
      .insert(schema.deviceCommands)
      .values({
        deviceId,
        cmd,
        payload: payload ? JSON.stringify(payload) : null,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning()

    const delivered = this.send(deviceId, { commandId: row.id, cmd, payload })
    if (delivered) {
      // reboot: device reloads immediately, can never send ack — mark done on delivery
      const status: CommandStatus = cmd === 'reboot' ? 'acked' : 'sent'
      await db
        .update(schema.deviceCommands)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.deviceCommands.id, row.id))
    }
    return row.id
  }

  async drain(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string,
    peer: Peer
  ): Promise<void> {
    const pending = await db
      .select()
      .from(schema.deviceCommands)
      .where(
        and(
          eq(schema.deviceCommands.deviceId, deviceId),
          eq(schema.deviceCommands.status, 'pending')
        )
      )
      .orderBy(schema.deviceCommands.createdAt)

    for (const cmd of pending) {
      peer.send(
        JSON.stringify({
          commandId: cmd.id,
          cmd: cmd.cmd,
          payload: cmd.payload ? JSON.parse(cmd.payload) : null
        })
      )
      const status: CommandStatus = cmd.cmd === 'reboot' ? 'acked' : 'sent'
      await db
        .update(schema.deviceCommands)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.deviceCommands.id, cmd.id))
    }
  }

  async handleAck(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string,
    commandId: number,
    status: 'acked' | 'failed',
    result: string | null
  ): Promise<void> {
    // Scope the update to the device on this socket so a peer can only ack its
    // OWN commands — it must not tamper with another device's command rows by
    // guessing an integer commandId.
    await db
      .update(schema.deviceCommands)
      .set({ status, result, updatedAt: new Date() })
      .where(
        and(
          eq(schema.deviceCommands.id, commandId),
          eq(schema.deviceCommands.deviceId, deviceId)
        )
      )
  }

  async onDisconnect(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string,
    peer: Peer
  ): Promise<void> {
    // Ignore a stale disconnect from a socket already superseded by a reconnect:
    // a new peer often opens before the old one's close fires, and deleting it /
    // reverting its commands here would drop or duplicate command delivery.
    if (this.peers.get(deviceId) !== peer) return

    await db
      .update(schema.deviceCommands)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(
        and(
          eq(schema.deviceCommands.deviceId, deviceId),
          eq(schema.deviceCommands.status, 'sent')
        )
      )
    this.peers.delete(deviceId)
  }
}

let _hub: CommandHub | null = null
export function useCommandHub(): CommandHub {
  if (!_hub) _hub = new CommandHub()
  return _hub
}

export function _resetCommandHub(): void {
  _hub = null
}
