package ai.lanka.kiosk.player

/** What to do with a manifest recovered from disk at boot. */
sealed interface RestoreDecision {
    /** Nothing usable — no saved manifest, or none of its media is cached. */
    data object Nothing : RestoreDecision

    /**
     * Replay [manifest] immediately (from the media cache, no network).
     *
     * [complete] is true only when every item of the *saved* manifest was
     * cached, i.e. the replay is byte-for-byte what the server last sent. The
     * caller must seed [ManifestDiffer] ONLY when complete: a degraded replay
     * (some items dropped) has the same playlistId+version as the server's
     * copy, so seeding would make the differ `Ignore` the real manifest and
     * strand the player on the partial playlist until the next version bump.
     */
    data class Replay(val manifest: Manifest, val complete: Boolean) : RestoreDecision
}

/**
 * Pure boot-time decision: given the manifest last persisted by
 * [ManifestStore] and a cache predicate, work out what can be played with no
 * server reachable.
 *
 * Items whose media is not cached are dropped rather than kept — offline they
 * would resolve to a network URL and fail at play time, showing a visible gap
 * for each one.
 */
fun restorableManifest(saved: Manifest?, isCached: (String) -> Boolean): RestoreDecision {
    if (saved == null || saved.items.isEmpty()) return RestoreDecision.Nothing
    val playable = saved.items.filter { isCached(it.sha256) }
    if (playable.isEmpty()) return RestoreDecision.Nothing
    return RestoreDecision.Replay(
        manifest = saved.copy(items = playable),
        complete = playable.size == saved.items.size
    )
}
