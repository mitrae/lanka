import type { NativeFSBridge } from './useReconciler'
import { backoff } from './backoff'

type WsFactory = (url: string) => WebSocket

interface Command {
  commandId: number
  cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request'
  payload: Record<string, unknown> | null
}

interface Ack {
  commandId: number
  status: 'acked' | 'failed'
  result?: string
}

export interface CommandChannelDeps {
  deviceId: string
  nativeFS?: NativeFSBridge
  onReload: () => void
  /** Injected in tests; defaults to global WebSocket */
  wsFactory?: WsFactory
}

export interface CommandChannelHandle {
  open(): void
  close(): void
}

export function createCommandChannel(deps: CommandChannelDeps): CommandChannelHandle {
  const factory: WsFactory = deps.wsFactory ?? ((url) => new WebSocket(url))
  let ws: WebSocket | null = null
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  function send(ack: Ack): void {
    if (ws?.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify(ack))
    }
  }

  function handleCommand(cmd: Command): void {
    const { commandId, cmd: type, payload } = cmd
    const nfs = deps.nativeFS

    if (type === 'reboot') {
      deps.onReload()
      return // no ack — page reloads
    }

    if (!nfs) {
      send({ commandId, status: 'failed', result: 'not supported' })
      return
    }

    if (type === 'screenshot') {
      try {
        const data = nfs.screenshot()
        send({ commandId, status: 'acked', result: data })
      }
      catch (e) {
        send({ commandId, status: 'failed', result: String(e) })
      }
      return
    }

    if (type === 'log-request') {
      try {
        const logs = nfs.getLogs()
        send({ commandId, status: 'acked', result: logs })
      }
      catch (e) {
        send({ commandId, status: 'failed', result: String(e) })
      }
      return
    }

    if (type === 'ota') {
      const { sha256, url } = (payload ?? {}) as Record<string, string>
      if (!sha256 || !url) {
        send({ commandId, status: 'failed', result: 'missing sha256 or url' })
        return
      }
      // Install result comes back async via window.__otaResult callback set by the APK
      ;(window as any).__otaResult = (id: number, status: 'acked' | 'failed') => {
        send({ commandId: id, status })
        delete (window as any).__otaResult
      }
      const downloaded = nfs.downloadApk(url, sha256)
      if (!downloaded) {
        send({ commandId, status: 'failed', result: 'download failed' })
        return
      }
      nfs.installApk(sha256, commandId)
      // ack sent async via window.__otaResult when the APK calls back
    }
  }

  function connect(): void {
    if (closed) return
    ws = factory(`/api/devices/${deps.deviceId}/ws`)

    ws.onopen = () => {
      attempt = 0
    }

    ws.onmessage = (e) => {
      let cmd: Command
      try {
        cmd = JSON.parse(e.data)
      }
      catch {
        return
      }
      handleCommand(cmd)
    }

    ws.onclose = () => {
      ws = null
      if (closed) return
      retryTimer = setTimeout(() => connect(), backoff(attempt))
      attempt += 1
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  return {
    open() {
      closed = false
      connect()
    },
    close() {
      closed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      ws?.close()
      ws = null
    }
  }
}
