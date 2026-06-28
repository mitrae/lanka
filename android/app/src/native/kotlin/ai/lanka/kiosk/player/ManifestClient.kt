package ai.lanka.kiosk.player

import ai.lanka.kiosk.MediaCache
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ManifestClient(
    private val deviceId: String,
    private val serverBaseUrl: String,   // e.g. BuildConfig.LANKA_SERVER_URL
    private val mediaPublicBase: String, // "" for proxy /media path
    private val http: OkHttpClient,
    private val json: Json,
    private val mediaCache: MediaCache,
    private val onManifest: (Manifest?) -> Unit,
    private val onError: (Throwable) -> Unit
) {
    private val differ = ManifestDiffer()
    private val poll = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "manifest-poll").apply { isDaemon = true }
    }
    private var es: EventSource? = null
    @Volatile private var attempt = 0
    @Volatile private var closed = false

    private val jsonContentType = "application/json".toMediaType()

    private fun mediaUrl(sha: String) =
        if (mediaPublicBase.isNotEmpty()) "${mediaPublicBase.trimEnd('/')}/media/$sha"
        else "$serverBaseUrl/media/$sha"

    fun register(surface: String, playerVersion: String) {
        val bodyStr = json.encodeToString(
            RegisterBody.serializer(), RegisterBody(deviceId, playerVersion, surface)
        )
        runCatching {
            http.newCall(
                Request.Builder()
                    .url("$serverBaseUrl/api/devices/register")
                    .post(bodyStr.toRequestBody(jsonContentType))
                    .build()
            ).execute().close()
        }.onFailure { /* retried on next reconcile error */ }
    }

    fun reconcile() {
        if (closed) return
        try {
            val req = Request.Builder()
                .url("$serverBaseUrl/api/devices/$deviceId/manifest")
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                attempt = 0
                val manifest: Manifest? = if (resp.code == 204) null else {
                    val raw = resp.body?.string().orEmpty()
                    if (raw.isBlank()) null
                    else json.decodeFromString(Manifest.serializer(), raw)
                }
                when (val d = differ.onFetched(manifest)) {
                    is ManifestDecision.Ignore -> {}
                    is ManifestDecision.EmitNull -> onManifest(null)
                    is ManifestDecision.Emit -> {
                        prefetch(d.manifest)
                        onManifest(d.manifest)
                    }
                }
            }
        } catch (e: Throwable) {
            onError(e)
            poll.schedule({ reconcile() }, backoff(attempt), TimeUnit.MILLISECONDS)
            attempt += 1
        }
    }

    private fun prefetch(m: Manifest) {
        val shas = m.items.map { it.sha256 }
        shas.filterNot { mediaCache.exists(it) }.forEach { sha ->
            runCatching { mediaCache.downloadSync(sha, mediaUrl(sha)) }
        }
        mediaCache.evictExcept(shas.toSet())
    }

    fun openStream() {
        if (closed || es != null) return
        val req = Request.Builder()
            .url("$serverBaseUrl/api/devices/$deviceId/stream")
            .build()
        es = EventSources.createFactory(http).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                reconcile()
            }
            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String
            ) {
                when (type) {
                    "manifest-changed" -> reconcile()
                    "reload" -> reconcile() // PlayerActivity may recreate
                }
            }
            override fun onFailure(
                eventSource: EventSource,
                t: Throwable?,
                response: Response?
            ) {
                es = null
                if (!closed) poll.schedule({ openStream() }, backoff(attempt), TimeUnit.MILLISECONDS)
            }
        })
    }

    fun startPolling() {
        poll.scheduleWithFixedDelay({ reconcile() }, 30, 30, TimeUnit.SECONDS)
    }

    fun close() {
        closed = true
        es?.cancel()
        es = null
        poll.shutdownNow()
    }
}
