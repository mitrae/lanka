import { useDb } from '~/server/db/client'
import { useCommandHub } from '~/server/services/command-hub'

function deviceIdFromUrl(url: string): string | null {
  const m = url.match(/\/devices\/([^/?#]+)\/ws/)
  return m?.[1] ?? null
}

export default defineWebSocketHandler({
  async open(peer) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return peer.close(1008, 'Missing device id')
    const hub = useCommandHub()
    hub.register(id, { send: (msg: string) => peer.send(msg) })
    await hub.drain(useDb(), id, { send: (msg: string) => peer.send(msg) })
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
    await useCommandHub().handleAck(
      useDb(),
      msg.commandId,
      msg.status,
      msg.result ?? null
    )
  },

  async close(peer) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    await useCommandHub().onDisconnect(useDb(), id)
  },

  async error(peer, _err) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    await useCommandHub().onDisconnect(useDb(), id)
  }
})
