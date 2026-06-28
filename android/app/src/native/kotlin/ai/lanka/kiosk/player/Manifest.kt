package ai.lanka.kiosk.player

import kotlinx.serialization.Serializable

@Serializable
data class ManifestItem(val id: Int, val type: String, val sha256: String, val durationMs: Int)

@Serializable
data class Manifest(
    val playlistId: Int,
    val playlistName: String,
    val version: Int,
    val items: List<ManifestItem>
)

@Serializable
data class RegisterBody(val deviceId: String, val playerVersion: String, val surface: String)
