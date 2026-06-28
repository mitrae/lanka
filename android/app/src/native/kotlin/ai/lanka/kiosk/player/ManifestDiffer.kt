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
