import { eq } from 'drizzle-orm'
import { useDb } from '~/server/db/client'
import { useCommandHub } from '~/server/services/command-hub'
import * as schema from '~/server/db/schema'

function deviceIdFromUrl(url: string): string | null {
  const m = url.match(/\/devices\/([^/?#]+)\/ws/)
  return m?.[1] ?? null
}

// One stable Peer wrapper per live socket, keyed by the crossws peer. The hub
// uses wrapper identity to ignore stale disconnects (reconnect race), so open
// and close MUST hand it the same object — a fresh `{ send }` per call would
// defeat that.
//
// LOAD-BEARING ASSUMPTION: crossws creates one `peer` instance per connection
// and passes that SAME instance to open/message/close/error (verified in
// crossws' node adapter). If a future crossws/nitro upgrade re-wraps the peer
// per hook, this WeakMap lookup would miss in close/error → sent commands never
// revert + the hub leaks stale peers. Re-verify on upgrade.
const wrappers = new WeakMap<object, { send: (msg: string) => void }>()

async function deviceExists(id: string): Promise<boolean> {
  const rows = await useDb()
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.id, id))
  return rows.length > 0
}

export default defineWebSocketHandler({
  async open(peer) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return peer.close(1008, 'Missing device id')
    // Reject sockets for devices that don't exist (the player registers before
    // opening this channel). Keeps junk/unknown connections out of the hub.
    if (!(await deviceExists(id))) return peer.close(1008, 'Unknown device')

    const wrapper = { send: (msg: string) => peer.send(msg) }
    wrappers.set(peer, wrapper)
    const hub = useCommandHub()
    hub.register(id, wrapper)
    await hub.drain(useDb(), id, wrapper)
  },

  async message(peer, raw) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    let msg: { commandId: number; status: 'acked' | 'failed'; result?: string }
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.text())
    } catch {
      return
    }
    if (!msg.commandId || !msg.status) return
    // Pass the socket's device id so the hub can scope the ack to this device.
    await useCommandHub().handleAck(
      useDb(),
      id,
      msg.commandId,
      msg.status,
      msg.result ?? null
    )
  },

  async close(peer) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    const wrapper = wrappers.get(peer)
    if (!wrapper) return
    wrappers.delete(peer)
    await useCommandHub().onDisconnect(useDb(), id, wrapper)
  },

  async error(peer, _err) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    const wrapper = wrappers.get(peer)
    if (!wrapper) return
    wrappers.delete(peer)
    await useCommandHub().onDisconnect(useDb(), id, wrapper)
  }
})
