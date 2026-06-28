package ai.lanka.kiosk.player

import kotlinx.serialization.json.*

interface CommandActions {
    fun reboot(): Boolean
    fun screenshot(): String
    fun getLogs(): String
    fun setKioskLock(enabled: Boolean)
    fun installOta(sha256: String, url: String, commandId: Int): Boolean
    fun reload()
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
                actions.setKioskLock(type == "kiosk-lock")
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
            else -> ack(commandId, "failed", "unknown command")
        }
    }
}
