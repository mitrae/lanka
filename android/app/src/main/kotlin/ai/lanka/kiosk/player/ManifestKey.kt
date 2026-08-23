package ai.lanka.kiosk.player

data class ManifestKey(val playlistId: Int, val version: Int)

fun shouldReconcile(prev: ManifestKey?, next: ManifestKey): Boolean =
    prev == null || prev.playlistId != next.playlistId || prev.version != next.version
