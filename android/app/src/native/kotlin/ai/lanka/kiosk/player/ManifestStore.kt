package ai.lanka.kiosk.player

import kotlinx.serialization.json.Json
import java.io.File

/**
 * Persists the last manifest the server successfully handed us, so a cold boot
 * with no server reachable (tailnet down, box power-cycled before the VPN comes
 * back, server restarting) can replay it straight from the media cache instead
 * of sitting on the standby banner with the bytes already on disk.
 *
 * Media was always cached; the *playlist* was not, so the cache was unusable
 * offline — this closes that gap.
 *
 * Writes are atomic (temp file + rename): these boxes are killed by pulling the
 * mains, and a half-written JSON file would poison every subsequent boot.
 * Every operation is best-effort — a storage failure must never take down the
 * player, so callers get null/no-op rather than an exception.
 */
class ManifestStore(private val file: File, private val json: Json) {

    fun save(manifest: Manifest) {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(json.encodeToString(Manifest.serializer(), manifest))
            if (!tmp.renameTo(file)) {
                // Some filesystems refuse rename-over; fall back to a direct write.
                file.writeText(tmp.readText())
                tmp.delete()
            }
        }
    }

    /** The saved manifest, or null when absent/unreadable/corrupt. */
    fun load(): Manifest? = runCatching {
        if (!file.exists()) null
        else json.decodeFromString(Manifest.serializer(), file.readText())
    }.getOrNull()

    /** Drop the saved manifest — the playlist was genuinely unassigned (204), so
     *  replaying it on the next boot would resurrect content the operator pulled. */
    fun clear() {
        runCatching { file.delete() }
    }

    companion object {
        const val FILE_NAME = "last-manifest.json"
    }
}
