package ai.lanka.kiosk.player

import kotlinx.serialization.Serializable

@Serializable
data class ManifestItem(val id: Int, val type: String, val sha256: String, val durationMs: Int)

@Serializable
data class ManifestInterrupt(
    val mediaId: Int,
    val sha256: String,
    val durationMs: Int,
    val startsAt: Long,
    val endsAt: Long
)

@Serializable
data class Manifest(
    val playlistId: Int,
    val playlistName: String,
    val version: Int,
    val items: List<ManifestItem>,
    // Null-defaulted so an older server (or a 204) still parses.
    val serverNow: Long? = null,
    val interrupt: ManifestInterrupt? = null
)

@Serializable
data class RegisterBody(val deviceId: String, val playerVersion: String, val surface: String)

// Only the field we need from /api/devices/register; Json has ignoreUnknownKeys.
@Serializable
data class RegisterResult(val commandSecret: String? = null)
