import { eq } from 'drizzle-orm'
import { useDb } from '~/server/db/client'
import { useCommandHub } from '~/server/services/command-hub'
import { decideWsAuth, hashDeviceSecret } from '~/server/services/device-secret'
import * as schema from '~/server/db/schema'

function deviceIdFromUrl(url: string): string | null {
  const m = url.match(/\/devices\/([^/?#]+)\/ws/)
  return m?.[1] ?? null
}

function secretFromUrl(url: string): string | null {
  const q = url.indexOf('?')
  if (q < 0) return null
  return new URLSearchParams(url.slice(q + 1)).get('secret')
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

export default defineWebSocketHandler({
  async open(peer) {
    const url = peer.request?.url ?? ''
    const id = deviceIdFromUrl(url)
    if (!id) return peer.close(1008, 'Missing device id')

    // Ratchet TOFU auth: unknown device → reject; once a client has connected
    // with the right secret the device is "active" and the secret is required;
    // before that it's grace-allowed so un-upgraded boxes keep working.
    const db = useDb()
    const [row] = await db
      .select({
        secret: schema.devices.commandSecret,
        active: schema.devices.commandSecretActive
      })
      .from(schema.devices)
      .where(eq(schema.devices.id, id))

    const presented = secretFromUrl(url)
    const decision = decideWsAuth({
      exists: !!row,
      storedHash: row?.secret ?? null,
      active: row?.active ?? false,
      presentedHash: presented ? hashDeviceSecret(presented) : null
    })
    if (!decision.allow) return peer.close(decision.closeCode ?? 1008, decision.reason ?? 'unauthorized')
    if (decision.activate) {
      await db
        .update(schema.devices)
        .set({ commandSecretActive: true })
        .where(eq(schema.devices.id, id))
    }

    const wrapper = { send: (msg: string) => peer.send(msg) }
    wrappers.set(peer, wrapper)
    const hub = useCommandHub()
    hub.register(id, wrapper)
    await hub.drain(db, id, wrapper)
  },

  async message(peer, raw) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    let msg: { commandId: number; status: 'acked' | 'failed'; result?: string; type?: string }
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.text())
    } catch {
      return
    }
    // Liveness probe from the player. A socket that dies half-open never fires
    // onclose on the client, so the player pings and treats silence as death —
    // this reply is what makes that silence meaningful. Must stay above the
    // commandId guard: a ping carries no commandId.
    if (msg.type === 'ping') return peer.send(JSON.stringify({ type: 'pong' }))
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
