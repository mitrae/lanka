package ai.lanka.kiosk.player

import kotlinx.serialization.json.*

interface CommandActions {
    fun reboot(): Boolean
    fun screenshot(): String
    fun getLogs(): String
    fun setKioskLock(enabled: Boolean)

    /**
     * Bring the player back to the foreground. Called on `kiosk-lock` so locking
     * a box that was left on the launcher actually restores the kiosk, rather
     * than only re-arming the snap-back for the next time the player is in front.
     */
    fun bringToFront()
    fun installOta(sha256: String, url: String, commandId: Int): Boolean
    fun reload()
    /** `set-surface`: switch the player surface ("webview" | "native"). Null = accepted, else the reason. */
    fun setSurface(name: String): String?
}

interface AckSender { fun send(json: String) }

class CommandDispatcher(private val actions: CommandActions, private val sender: AckSender) {

    private fun ack(commandId: Int, status: String, result: String? = null) = sender.send(
        buildJsonObject {
            put("commandId", commandId)
            put("status", status)
            if (result != null) put("result", result)
        }.toString()
    )

    fun handle(commandJson: String) {
        val obj = runCatching { Json.parseToJsonElement(commandJson).jsonObject }.getOrNull() ?: return
        val commandId = obj["commandId"]?.jsonPrimitive?.intOrNull ?: return
        val type = obj["cmd"]?.jsonPrimitive?.contentOrNull ?: return
        val payload = obj["payload"] as? JsonObject

        when (type) {
            "reboot" -> {
                runCatching { if (actions.reboot()) return }
                actions.reload()
            }
            "screenshot" -> runCatching { ack(commandId, "acked", actions.screenshot()) }
                .onFailure { ack(commandId, "failed", it.toString()) }
            "kiosk-lock", "kiosk-unlock" -> runCatching {
                val lock = type == "kiosk-lock"
                actions.setKioskLock(lock)
                // Locking must RESTORE the kiosk, not just re-arm it: the box may
                // already be parked on the launcher after an unlock, and the
                // snap-back only triggers when the player leaves the foreground.
                // Best-effort: the lock itself already applied, so a box that
                // can't launch from the background (no SYSTEM_ALERT_WINDOW)
                // must still ack rather than report the whole command failed.
                if (lock) runCatching { actions.bringToFront() }
                ack(commandId, "acked")
            }.onFailure { ack(commandId, "failed", it.toString()) }
            "log-request" -> runCatching { ack(commandId, "acked", actions.getLogs()) }
                .onFailure { ack(commandId, "failed", it.toString()) }
            "ota" -> {
                val sha = payload?.get("sha256")?.jsonPrimitive?.contentOrNull
                val url = payload?.get("url")?.jsonPrimitive?.contentOrNull
                if (sha.isNullOrBlank() || url.isNullOrBlank()) {
                    ack(commandId, "failed", "missing sha256 or url")
                    return
                }
                if (!actions.installOta(sha, url, commandId)) ack(commandId, "failed", "install failed")
                // success ack is sent asynchronously via OtaResultBus callback in CommandClient
            }
            "set-surface" -> {
                val surface = payload?.get("surface")?.jsonPrimitive?.contentOrNull
                if (surface.isNullOrBlank()) {
                    ack(commandId, "failed", "missing surface")
                    return
                }
                // Ack BEFORE the surface restarts: SurfaceSwitcher delays recreate()
                // by ACK_GRACE_MS so this frame leaves the socket first.
                val reason = runCatching { actions.setSurface(surface) }.getOrElse { it.toString() }
                if (reason == null) ack(commandId, "acked") else ack(commandId, "failed", reason)
            }
            else -> ack(commandId, "failed", "unknown command")
        }
    }
}
