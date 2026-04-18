// app/composables/player/useReconciler.ts
import type { ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { shouldReconcile } from './shouldReconcile'
import { backoff } from './backoff'

export type StreamState = 'connecting' | 'connected' | 'disconnected'

type EventSourceFactory = (url: string) => EventSource

export interface ReconcilerDeps {
  api: ApiClient
  deviceId: string
  eventSourceFactory?: EventSourceFactory
  onReload?: () => void
}

export interface ReconcilerHandle {
  reconcile(): Promise<void>
  openStream(): void
  startPolling(): void
  close(): void
  onManifest(fn: (m: Manifest | null) => void): () => void
  onError(fn: (e: unknown) => void): () => void
  getStreamState(): StreamState
}

/**
 * Owns the reconcile loop: manifest fetch + diff + SSE + 30s safety
 * poll. Does NOT own the scheduler — it emits `onManifest(m|null)` and
 * lets the caller wire up `<PlayerStage>` / scheduler / no-content
 * screen as appropriate.
 *
 * - On fetch success: if manifest key (playlistId+version) changed,
 *   emit onManifest(m). If null (204), emit onManifest(null).
 * - On fetch failure: emit onError, then schedule a retry at
 *   backoff(attempt); reset attempt on next success.
 * - On SSE `manifest-changed`: trigger reconcile().
 * - On SSE `reload`: invoke deps.onReload().
 */
export function createReconciler(deps: ReconcilerDeps): ReconcilerHandle {
  const factory: EventSourceFactory =
    deps.eventSourceFactory ?? ((url) => new EventSource(url))

  let last: { playlistId: number; version: number } | null = null
  let hasEmitted = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let es: EventSource | null = null
  let streamState: StreamState = 'disconnected'

  const manifestHandlers = new Set<(m: Manifest | null) => void>()
  const errorHandlers = new Set<(e: unknown) => void>()

  function emitManifest(m: Manifest | null): void {
    for (const fn of manifestHandlers) fn(m)
  }
  function emitError(e: unknown): void {
    for (const fn of errorHandlers) fn(e)
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  async function reconcile(): Promise<void> {
    clearRetryTimer()
    try {
      const m = await deps.api.getManifest(deps.deviceId)
      attempt = 0
      if (m === null) {
        // Only emit on first fetch or on the transition from manifest → null.
        // Subsequent null-null polls stay silent so telemetry doesn't fire repeatedly.
        if (last !== null || !hasEmitted) {
          last = null
          hasEmitted = true
          emitManifest(null)
        }
        return
      }
      const key = { playlistId: m.playlistId, version: m.version }
      if (!shouldReconcile(last, key)) return
      last = key
      hasEmitted = true
      emitManifest(m)
    } catch (err) {
      emitError(err)
      retryTimer = setTimeout(() => {
        void reconcile()
      }, backoff(attempt))
      attempt += 1
    }
  }

  function openStream(): void {
    if (es) return
    streamState = 'connecting'
    es = factory(`/api/devices/${deps.deviceId}/stream`)
    es.addEventListener('open', () => {
      streamState = 'connected'
      // Catch up any changes that happened during the disconnect.
      void reconcile()
    })
    es.addEventListener('error', () => {
      // Browser EventSource auto-reconnects; surface current state only.
      streamState = 'connecting'
    })
    es.addEventListener('manifest-changed', () => {
      void reconcile()
    })
    es.addEventListener('reload', () => {
      deps.onReload?.()
    })
    // `ping` is keep-alive only.
  }

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void reconcile()
    }, 30_000)
  }

  function close(): void {
    clearRetryTimer()
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (es) {
      es.close()
      es = null
    }
    streamState = 'disconnected'
    manifestHandlers.clear()
    errorHandlers.clear()
  }

  return {
    reconcile,
    openStream,
    startPolling,
    close,
    onManifest(fn) {
      manifestHandlers.add(fn)
      return () => manifestHandlers.delete(fn)
    },
    onError(fn) {
      errorHandlers.add(fn)
      return () => errorHandlers.delete(fn)
    },
    getStreamState() {
      return streamState
    }
  }
}
