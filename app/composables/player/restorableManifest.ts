// app/composables/player/restorableManifest.ts
//
// Mirror of the native player's ManifestRestore.kt — keep the two in step.
import type { Manifest } from '~/app/types/api'

export type RestoreDecision =
  /** Nothing usable — no saved manifest, or none of its media is cached. */
  | { kind: 'nothing' }
  /**
   * Replay `manifest` immediately from the local cache, with no network.
   *
   * `complete` is true only when every item of the *saved* manifest was cached,
   * i.e. the replay is exactly what the server last sent. Callers must adopt the
   * manifest key as already-seen ONLY when complete: a degraded replay carries
   * the same playlistId+version as the server's copy, so adopting it would make
   * the reconciler skip the real manifest and strand the player on the partial
   * playlist until the next version bump.
   */
  | { kind: 'replay'; manifest: Manifest; complete: boolean }

/**
 * Pure boot-time decision: given the last persisted manifest and a cache
 * predicate, work out what can be played with no server reachable.
 *
 * Items whose media is not cached are dropped rather than kept — offline they
 * would resolve to a network URL and fail at play time, leaving a visible gap
 * for each one.
 *
 * In a plain browser there is no local media cache, so `isCached` should report
 * everything as cached: if the page itself loaded, the server was reachable.
 */
export function restorableManifest(
  saved: Manifest | null,
  isCached: (sha256: string) => boolean
): RestoreDecision {
  if (saved === null || saved.items.length === 0) return { kind: 'nothing' }
  const playable = saved.items.filter(i => isCached(i.sha256))
  if (playable.length === 0) return { kind: 'nothing' }
  return {
    kind: 'replay',
    manifest: { ...saved, items: playable },
    complete: playable.length === saved.items.length
  }
}
