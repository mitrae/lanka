// app/composables/player/useReconciler.ts
import type { ApiClient } from '~/app/composables/useApiClient'
import type { Manifest } from '~/app/types/api'
import { shouldReconcile } from './shouldReconcile'
import { backoff } from './backoff'
import { restorableManifest } from './restorableManifest'

export type StreamState = 'connecting' | 'connected' | 'disconnected'

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
}

/**
 * Persists the last manifest the server handed us, so a reload/reboot with no
 * server reachable can replay it from the media cache instead of sitting on the
 * standby screen with the bytes already on disk.
 */
export interface ManifestStore {
  load(): Manifest | null
  save(m: Manifest): void
  clear(): void
}

/**
 * localStorage-backed store, keyed per device so two players sharing an origin
 * can't inherit each other's playlist. Every call is best-effort: storage can be
 * absent or throw (private mode, disabled site data), and that must never take
 * down the player.
 */
export function createLocalManifestStore(deviceId: string): ManifestStore {
  const key = `lanka:last-manifest:${deviceId}`
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? (JSON.parse(raw) as Manifest) : null
      } catch {
        return null
      }
    },
    save(m) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(m))
      } catch {
        /* no storage — offline replay is simply unavailable */
      }
    },
    clear() {
      try {
        globalThis.localStorage?.removeItem(key)
      } catch {
        /* nothing to do */
      }
    }
  }
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
   * Where the last manifest is persisted for offline replay. Defaults to
   * localStorage; pass an explicit store in tests, or `null` to disable
   * persistence entirely.
   */
  manifestStore?: ManifestStore | null
}

export interface ReconcilerHandle {
  reconcile(): Promise<void>
  /**
   * Replay the last persisted manifest from the local cache, with no network.
   *
   * Call BEFORE the first `reconcile()`: it fills the screen immediately from
   * storage, so a player that comes up before its VPN (or while the server is
   * down) keeps playing instead of showing standby. The subsequent live fetch
   * then either dedupes to a no-op (same version) or emits the newer playlist.
   *
   * Returns the replayed manifest, or null when there was nothing usable.
   */
  restorePersisted(): Manifest | null
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
 */
export function createReconciler(deps: ReconcilerDeps): ReconcilerHandle {
  const factory: EventSourceFactory =
    deps.eventSourceFactory ?? ((url) => new EventSource(url))

  const manifestStore: ManifestStore | null =
    deps.manifestStore === undefined
      ? createLocalManifestStore(deps.deviceId)
      : deps.manifestStore

  let last: { playlistId: number; version: number } | null = null
  let hasEmitted = false
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
      const m = await deps.api.getManifest(deps.deviceId)
      attempt = 0
      if (m === null) {
        // Only emit on first fetch or on the transition from manifest → null.
        // Subsequent null-null polls stay silent so telemetry doesn't fire repeatedly.
        if (last !== null || !hasEmitted) {
          last = null
          hasEmitted = true
          // Playlist genuinely unassigned — forget it, so the next boot doesn't
          // resurrect content the operator pulled.
          manifestStore?.clear()
          emitManifest(null)
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
      // Save after the download pass, so what we persist is what we just cached.
      manifestStore?.save(m)
      emitManifest(m)
    } catch (err) {
      emitError(err)
      retryTimer = setTimeout(() => {
        void reconcile()
      }, backoff(attempt))
      attempt += 1
    }
  }

  function restorePersisted(): Manifest | null {
    if (!manifestStore) return null
    // Without the NativeFS bridge there is no local media cache — but if the SPA
    // itself loaded, the server was reachable, so treat everything as playable.
    const isCached = deps.nativeFS
      ? (sha256: string) => deps.nativeFS!.exists(sha256)
      : () => true
    const decision = restorableManifest(manifestStore.load(), isCached)
    if (decision.kind === 'nothing') return null
    // Adopting the key on a degraded replay would make the live manifest look
    // unchanged — see RestoreDecision above.
    if (decision.complete) {
      last = {
        playlistId: decision.manifest.playlistId,
        version: decision.manifest.version
      }
      hasEmitted = true
    }
    emitManifest(decision.manifest)
    return decision.manifest
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
    restorePersisted,
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
