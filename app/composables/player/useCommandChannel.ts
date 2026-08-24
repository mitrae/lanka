import type { NativeFSBridge } from './useReconciler'
import { backoff } from './backoff'

type WsFactory = (url: string) => WebSocket

interface Command {
  commandId: number
  cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request' | 'kiosk-lock' | 'kiosk-unlock' | 'set-surface'
  payload: Record<string, unknown> | null
}

interface Ack {
  commandId: number
  status: 'acked' | 'failed'
  result?: string
}

/**
 * How often the player pings the server over the command socket.
 *
 * A WebSocket that dies half-open (the server closed, the client's TCP sits in
 * CLOSE_WAIT) never fires onclose or onerror — `readyState` stays OPEN forever
 * and every dashboard command queues server-side, invisibly. Observed in the
 * field: six kiosk-lock/unlock commands sat queued for minutes, then all
 * replayed at once on the next reconnect, leaving the box in whatever state the
 * backlog happened to end on.
 *
 * The server has no heartbeat of its own, so silence alone means nothing — an
 * idle healthy socket also receives nothing. Hence an active ping/pong.
 */
const PING_MS = 25_000

/**
 * Reconnect when nothing at all has arrived for this long. Must comfortably
 * exceed PING_MS so one slow round trip can't trigger a needless reconnect;
 * two missed pongs is the trigger.
 */
const STALE_MS = 70_000

export interface CommandChannelDeps {
  deviceId: string
  /** Per-device command-channel secret; sent as ?secret= so the server can
   *  authenticate this socket once the device has adopted one (TOFU). */
  secret?: string | null
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
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let lastSeenAt = 0

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * Drop a socket the server has stopped answering on and reconnect.
   *
   * Calling close() is what gets us back on the air: it triggers onclose, which
   * owns the backoff/reconnect. If the socket is wedged badly enough that
   * onclose never fires, the reconnect is scheduled here instead — never
   * trusting the socket to report its own death is the whole point.
   */
  function dropAndReconnect(): void {
    stopHeartbeat()
    const dead = ws
    ws = null
    try {
      dead?.close()
    }
    catch { /* already torn down */ }
    if (closed) return
    if (retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        connect()
      }, backoff(attempt))
      attempt += 1
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    lastSeenAt = Date.now()
    heartbeatTimer = setInterval(() => {
      if (closed) return
      if (Date.now() - lastSeenAt > STALE_MS) {
        dropAndReconnect()
        return
      }
      // A dead half-open socket still accepts send() without throwing, so this
      // is a liveness probe, not a delivery guarantee — the pong is the signal.
      try {
        if (ws?.readyState === 1 /* OPEN */) ws.send(JSON.stringify({ type: 'ping' }))
      }
      catch {
        dropAndReconnect()
      }
    }, PING_MS)
  }

  function send(ack: Ack): void {
    if (ws?.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify(ack))
    }
  }

  function handleCommand(cmd: Command): void {
    const { commandId, cmd: type, payload } = cmd
    const nfs = deps.nativeFS

    if (type === 'reboot') {
      // Prefer a real OS reboot on a device-owner APK; fall back to a soft
      // player reload on a box without device-owner powers (or a non-APK
      // browser). Either way no ack is sent — the command-hub marks reboot
      // acked on delivery, since a rebooting device can never reply.
      if (nfs?.reboot) {
        try {
          if (nfs.reboot()) return
        }
        catch { /* fall through to reload */ }
      }
      deps.onReload()
      return
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

    if (type === 'kiosk-lock' || type === 'kiosk-unlock') {
      if (!nfs.setKioskLock) {
        send({ commandId, status: 'failed', result: 'not supported' })
        return
      }
      try {
        nfs.setKioskLock(type === 'kiosk-lock')
        send({ commandId, status: 'acked' })
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

    if (type === 'set-surface') {
      const surface = (payload as Record<string, unknown> | null)?.surface
      if (typeof surface !== 'string' || !surface) {
        send({ commandId, status: 'failed', result: 'missing surface' })
        return
      }
      if (!nfs.setSurface) {
        send({ commandId, status: 'failed', result: 'not supported' })
        return
      }
      try {
        // The APK commits the choice synchronously and recreates the Activity
        // ~500 ms later, so this ack still leaves the socket.
        const reason = nfs.setSurface(surface)
        if (reason) send({ commandId, status: 'failed', result: reason })
        else send({ commandId, status: 'acked' })
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
      const absoluteUrl = url.startsWith('http') ? url : new URL(url, window.location.origin).href
      const downloaded = nfs.downloadApk(absoluteUrl, sha256)
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
    const base = `/api/devices/${deps.deviceId}/ws`
    const url = deps.secret
      ? `${base}?secret=${encodeURIComponent(deps.secret)}`
      : base
    ws = factory(url)

    ws.onopen = () => {
      attempt = 0
      startHeartbeat()
    }

    ws.onmessage = (e) => {
      // ANY inbound frame proves the socket is alive, so stamp before parsing —
      // even a malformed one means the server is still talking to us.
      lastSeenAt = Date.now()
      let cmd: Command
      try {
        cmd = JSON.parse(e.data)
      }
      catch {
        return
      }
      // Heartbeat reply — liveness only, never a command.
      if ((cmd as unknown as { type?: string }).type === 'pong') return
      handleCommand(cmd)
    }

    ws.onclose = () => {
      stopHeartbeat()
      ws = null
      if (closed) return
      if (retryTimer !== null) return // dropAndReconnect already scheduled one
      retryTimer = setTimeout(() => {
        retryTimer = null
        connect()
      }, backoff(attempt))
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
      stopHeartbeat()
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      ws?.close()
      ws = null
    }
  }
}
