// app/composables/player/useReconciler.ts
import type { ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { shouldReconcile } from './shouldReconcile'
import { backoff } from './backoff'

export type StreamState = 'connecting' | 'connected' | 'disconnected'

/**
 * Give up on a manifest fetch that never settles.
 *
 * A TCP connection that dies half-open leaves an in-flight request hanging with
 * no error and no response, so `reconcile()` would await forever: the 30 s poll
 * keeps firing but every tick parks on a dead socket, and the player silently
 * stops noticing playlist changes until the app is restarted. Observed in the
 * field — the server was serving the manifest correctly while the box sat on
 * "No content assigned" through several poll cycles.
 *
 * Failing fast routes into the existing catch → onError → backoff retry, which
 * establishes a fresh connection.
 */
const FETCH_TIMEOUT_MS = 15_000

/** Reject if `p` has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`manifest fetch timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

type EventSourceFactory = (url: string) => EventSource

/** Subset of window.NativeFS used by the reconciler. */
export interface NativeFSBridge {
  exists(sha256: string): boolean
  /** Downloads url to local cache. Returns true on success, false on failure. */
  download(sha256: string, url: string): boolean
  /** Deletes cached files whose sha256 is not in the JSON-encoded array. */
  evictExcept(sha256ListJson: string): void
  // Plan 7 — remote management
  /** Downloads an APK from url to local cache. Returns true on success. */
  downloadApk(url: string, sha256: string): boolean
  /** Triggers OTA install; result comes back async via window.__otaResult(commandId, status). */
  installApk(sha256: string, commandId: number): boolean
  /** Captures a screenshot and returns a data-URI string. */
  screenshot(): string
  /** Returns recent device log lines as a plain-text string. */
  getLogs(): string
  /** Returns the currently installed APK version string. */
  getAppVersion(): string
  /**
   * Reboots the device. Present only on a device-owner APK; returns false when
   * the box lacks device-owner powers, so the caller falls back to a reload.
   */
  reboot?(): boolean
  /**
   * Enables/disables the kiosk snap-back lock at runtime (dashboard maintenance
   * toggle). Present on APKs that support the lock command.
   */
  setKioskLock?(enabled: boolean): void
  /**
   * Switches the player surface ("webview" | "native"). Returns "" when the
   * switch was accepted (the APK restarts the player shortly after), else the
   * failure reason. Absent on APKs older than 0.3.0-surface.
   */
  setSurface?(name: string): string
}

export interface ReconcilerDeps {
  api: ApiClient
  deviceId: string
  /** Android APK NativeFS bridge. When present, media is pre-downloaded before manifest emit. */
  nativeFS?: NativeFSBridge
  /** Returns the network URL for a sha256 — used as download source. Must not include a NativeFS check. */
  cdnUrl?: (sha256: string) => string
  eventSourceFactory?: EventSourceFactory
  onReload?: () => void
  /**
   * Build id compiled into THIS bundle (`__LANKA_BUILD__`). When the manifest
   * reports a different server build, the page is reloaded instead of the
   * manifest being emitted — see reconcile(). Absent in tests and on bundles
   * that predate the field.
   */
  bundleBuild?: string
  /**
   * Remembers which server build we already reloaded for, across page loads.
   * Without it, a WebView serving the old shell from cache would come back
   * mismatched after every reload and blank the screen every 30 s forever.
   * Defaults to localStorage; tests pass an in-memory one.
   */
  reloadGuard?: { get(): string | null; set(build: string): void }
}

export interface ReconcilerHandle {
  reconcile(): Promise<void>
  openStream(): void
  startPolling(): void
  close(): void
  onManifest(fn: (m: Manifest | null) => void): () => void
  onError(fn: (e: unknown) => void): () => void
  /** Fires true when a download sync starts, false when it ends. */
  onSyncing(fn: (syncing: boolean) => void): () => void
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
 * - On a manifest whose `playerBuild` differs from `deps.bundleBuild`: invoke
 *   deps.onReload() (once per server build) and emit nothing. This is how a
 *   deploy reaches a box: the SSE `reload` and WS `reboot` both ride sockets
 *   that go half-open in the field, while the 30 s poll keeps working —
 *   observed on prod, a box polled through two deploys without ever loading
 *   the new bundle because nothing it could still hear told it to.
 */
export function createReconciler(deps: ReconcilerDeps): ReconcilerHandle {
  const factory: EventSourceFactory =
    deps.eventSourceFactory ?? ((url) => new EventSource(url))

  let last: { playlistId: number; version: number } | null = null
  let hasEmitted = false
  let reloadRequested = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let es: EventSource | null = null
  let streamState: StreamState = 'disconnected'

  const manifestHandlers = new Set<(m: Manifest | null) => void>()
  const errorHandlers = new Set<(e: unknown) => void>()
  const syncingHandlers = new Set<(syncing: boolean) => void>()

  function emitManifest(m: Manifest | null): void {
    for (const fn of manifestHandlers) fn(m)
  }
  function emitError(e: unknown): void {
    for (const fn of errorHandlers) fn(e)
  }
  function emitSyncing(syncing: boolean): void {
    for (const fn of syncingHandlers) fn(syncing)
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
      const m = await withTimeout(
        Promise.resolve(deps.api.getManifest(deps.deviceId)),
        FETCH_TIMEOUT_MS
      )
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
      if (staleBundle(m)) {
        // Never mount a playlist on a bundle the server has moved past; the
        // reload brings the current one, which reconciles from scratch.
        if (!reloadRequested) {
          reloadRequested = true
          deps.reloadGuard?.set(m.playerBuild!)
          deps.onReload?.()
        }
        return
      }
      const key = { playlistId: m.playlistId, version: m.version }
      if (!shouldReconcile(last, key)) return
      last = key
      hasEmitted = true
      // Pre-download uncached items when the Android NativeFS bridge is present.
      if (deps.nativeFS && deps.cdnUrl) {
        const sha256s = m.items.map(i => i.sha256)
        const uncached = sha256s.filter(s => !deps.nativeFS!.exists(s))
        if (uncached.length > 0) {
          emitSyncing(true)
          for (const sha256 of uncached) {
            deps.nativeFS!.download(sha256, deps.cdnUrl!(sha256))
          }
          emitSyncing(false)
        }
        deps.nativeFS!.evictExcept(JSON.stringify(sha256s))
      }
      emitManifest(m)
    } catch (err) {
      emitError(err)
      retryTimer = setTimeout(() => {
        void reconcile()
      }, backoff(attempt))
      attempt += 1
    }
  }

  /** True when this bundle should be replaced by a reload for `m`'s build —
   *  and we have not already tried exactly that for this server build. */
  function staleBundle(m: Manifest): boolean {
    if (!deps.bundleBuild || !m.playerBuild) return false
    if (m.playerBuild === deps.bundleBuild) return false
    // Already reloaded for this build and still stale: something is serving
    // the old shell. Playing the stale bundle beats a blank screen every 30 s.
    if (deps.reloadGuard?.get() === m.playerBuild) return false
    return true
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
    syncingHandlers.clear()
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
    onSyncing(fn) {
      syncingHandlers.add(fn)
      return () => syncingHandlers.delete(fn)
    },
    getStreamState() {
      return streamState
    }
  }
}
