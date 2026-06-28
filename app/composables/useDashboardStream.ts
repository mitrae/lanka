import { ref, type Ref } from 'vue'

export type StreamState = 'connecting' | 'connected' | 'disconnected'

export interface DeviceEventPayload {
  deviceId: string
  event: string
  data: unknown
}

export interface DashboardStream {
  state: Ref<StreamState>
  onDeviceEvent(handler: (p: DeviceEventPayload) => void): () => void
  close(): void
}

type EventSourceFactory = (url: string) => EventSource

export function createDashboardStream(
  url: string,
  factory: EventSourceFactory = (u) => new EventSource(u)
): DashboardStream {
  const state = ref<StreamState>('connecting')
  const src = factory(url)
  const handlers = new Set<(p: DeviceEventPayload) => void>()

  src.addEventListener('open', () => {
    state.value = 'connected'
  })

  src.addEventListener('error', () => {
    // Browser EventSource auto-reconnects; we surface the current state.
    state.value = src.readyState === 1 ? 'connected' : 'connecting'
  })

  src.addEventListener('device-event', (ev: MessageEvent) => {
    try {
      const payload = JSON.parse(ev.data) as DeviceEventPayload
      for (const h of handlers) h(payload)
    } catch (err) {
      console.error('[dashboard-stream] malformed device-event', err)
    }
  })

  // `ping` events keep the connection alive; nothing to do with them.

  return {
    state,
    onDeviceEvent(fn) {
      handlers.add(fn)
      return () => {
        handlers.delete(fn)
      }
    },
    close() {
      src.close()
      state.value = 'disconnected'
      handlers.clear()
    }
  }
}

// Routes that must never open the authenticated dashboard SSE.
const NON_DASHBOARD_PATHS = new Set(['/login', '/forgot-password', '/reset-password'])

/**
 * Whether to open the dashboard SSE (`/api/dashboard/stream`). The server gates
 * that endpoint to admin/super, so opening it as anyone else (notably a `client`
 * on /portal/*) produces an infinite 403 reconnect loop. Open it only for an
 * authenticated admin/super on an actual dashboard route — never on /player
 * (kiosk, no session) or the pre-auth pages.
 */
export function shouldOpenDashboardStream(o: {
  authenticated: boolean
  role: string | null
  path: string
}): boolean {
  if (!o.authenticated) return false
  if (o.role !== 'admin' && o.role !== 'super') return false
  if (o.path === '/player' || o.path.startsWith('/player/')) return false
  if (NON_DASHBOARD_PATHS.has(o.path)) return false
  return true
}

let _singleton: DashboardStream | null = null

export function useDashboardStream(): DashboardStream {
  if (!_singleton) {
    _singleton = createDashboardStream('/api/dashboard/stream')
  }
  return _singleton
}

// Test-only helper
export function _resetDashboardStream(): void {
  _singleton?.close()
  _singleton = null
}
