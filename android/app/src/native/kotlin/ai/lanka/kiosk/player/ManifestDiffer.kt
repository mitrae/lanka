package ai.lanka.kiosk.player

sealed interface ManifestDecision {
    data object Ignore : ManifestDecision
    data object EmitNull : ManifestDecision
    data class Emit(val manifest: Manifest) : ManifestDecision
}

/** Pure manifest emit/dedup logic, mirroring useReconciler. */
class ManifestDiffer {
    private var last: ManifestKey? = null
    private var hasEmitted = false

    /**
     * Adopt [key] as the already-emitted state without emitting anything.
     *
     * Used when a persisted manifest is replayed from disk at boot: the server's
     * first successful fetch then resolves to `Ignore` for the same
     * playlistId+version, so playback continues seamlessly instead of tearing
     * down and rebuilding the PlaybackView for content that is already on screen.
     *
     * Only seed with a *complete* replay — see [RestoreDecision.Replay.complete].
     */
    fun seed(key: ManifestKey) {
        last = key
        hasEmitted = true
    }

    fun onFetched(result: Manifest?): ManifestDecision {
        if (result == null) {
            return if (last != null || !hasEmitted) {
                last = null; hasEmitted = true; ManifestDecision.EmitNull
            } else ManifestDecision.Ignore
        }
        val key = ManifestKey(result.playlistId, result.version)
        if (!shouldReconcile(last, key)) return ManifestDecision.Ignore
        last = key; hasEmitted = true
        return ManifestDecision.Emit(result)
    }
}
