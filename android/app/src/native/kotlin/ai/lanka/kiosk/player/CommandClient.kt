package ai.lanka.kiosk.player

import ai.lanka.kiosk.OtaResultBus
import android.util.Log
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * OkHttp WebSocket transport for the command channel.
 *
 * Connects to `/api/devices/:id/ws`, feeds received JSON to a [CommandDispatcher],
 * and reconnects with exponential backoff on disconnect.
 *
 * Construction cycle resolution: CommandClient owns the live WebSocket. It
 * creates the [CommandDispatcher] internally, wiring an [AckSender] that
 * writes to the current socket (no-op when the socket is null/closed).
 * The caller supplies [CommandActions] only — no dispatcher is pre-built
 * outside this class.
 *
 * OTA result ack: on a successful [CommandActions.installOta] kick-off the
 * dispatcher sends no ack. Instead, [CommandClient] registers an
 * [OtaResultBus] listener that fires the final `{commandId, status}` ack
 * when the installer completes.
 */
class CommandClient(
    private val deviceId: String,
    private val serverBaseUrl: String,
    private val http: OkHttpClient,
    actions: CommandActions
) {
    private val TAG = "CommandClient"

    @Volatile private var socket: WebSocket? = null
    @Volatile private var closed = false
    private val attempt = AtomicInteger(0)

    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "command-ws").apply { isDaemon = true }
    }

    // AckSender that writes to the current socket; silently drops if socket is gone.
    private val ackSender = object : AckSender {
        override fun send(json: String) {
            @Suppress("USELESS_CAST")
            socket?.send(json as String)
        }
    }

    private val dispatcher = CommandDispatcher(actions, ackSender)

    init {
        // When OTA finishes (success or failure), send the async result ack.
        OtaResultBus.setListener { commandId, status ->
            val json = buildJsonObject {
                put("commandId", commandId)
                put("status", status)
            }.toString()
            ackSender.send(json)
        }
    }

    private val wsUrl get() = "${serverBaseUrl.trimEnd('/')}/api/devices/$deviceId/ws"

    fun open() {
        if (closed) return
        val req = Request.Builder().url(wsUrl).build()
        http.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "WS connected: $wsUrl")
                socket = webSocket
                attempt.set(0)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                dispatcher.handle(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                socket = null
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS failure (attempt ${attempt.get()}): ${t.message}")
                socket = null
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (closed) return
        val delay = backoff(attempt.getAndIncrement())
        Log.d(TAG, "WS reconnect in ${delay}ms")
        scheduler.schedule({ open() }, delay, TimeUnit.MILLISECONDS)
    }

    fun close() {
        closed = true
        OtaResultBus.clearListener()
        socket?.close(1000, "client closing")
        socket = null
        scheduler.shutdownNow()
    }
}
