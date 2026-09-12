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
    private val onError: (Throwable) -> Unit,
    // SSE "reload" handler. Null = the default behaviour, a plain reconcile()
    // (re-fetch the manifest). NativeSurface passes a handler that recreate()s
    // the activity for a clean restart. (A null default rather than a lambda
    // because a constructor-parameter default can't reference instance methods.)
    private val onReload: (() -> Unit)? = null,
    // Called with the raw command-channel secret the FIRST time /register issues
    // one (TOFU). The caller persists it (DeviceSecretStore) for the command WS.
    private val onCommandSecret: ((String) -> Unit)? = null,
    // Invoked on EVERY successful fetch, unlike onManifest which the differ
    // gates. The window rolls to tomorrow after each fire and the clock offset
    // must stay fresh, but neither may remount the PlaybackView.
    private val onClock: ((Long?, ManifestInterrupt?) -> Unit)? = null
) {
    private val differ = ManifestDiffer()
    private val interruptGate = PrefetchGate()
    private val poll = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "manifest-poll").apply { isDaemon = true }
    }
    private var es: EventSource? = null
    @Volatile private var attempt = 0
    @Volatile private var closed = false

    private val jsonContentType = "application/json".toMediaType()

    // Dedicated SSE client with infinite read timeout so quiet intervals don't kill the stream.
    // The original `http` (finite timeout) is still used for manifest GET and register POST.
    private val sseHttp by lazy {
        http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    }

    private fun mediaUrl(sha: String) =
        if (mediaPublicBase.isNotEmpty()) "${mediaPublicBase.trimEnd('/')}/media/$sha"
        else "$serverBaseUrl/media/$sha"

    fun register(surface: String, playerVersion: String) {
        val bodyStr = json.encodeToString(
            RegisterBody.serializer(), RegisterBody(deviceId, playerVersion, surface)
        )
        runCatching {
            // /api/devices/register expects deviceId in the JSON body, not the URL path.
            http.newCall(
                Request.Builder()
                    .url("$serverBaseUrl/api/devices/register")
                    .post(bodyStr.toRequestBody(jsonContentType))
                    .build()
            ).execute().use { resp ->
                val raw = resp.body?.string()
                if (resp.isSuccessful && !raw.isNullOrEmpty()) {
                    val secret = runCatching {
                        json.decodeFromString(RegisterResult.serializer(), raw).commandSecret
                    }.getOrNull()
                    if (!secret.isNullOrEmpty()) onCommandSecret?.invoke(secret)
                }
            }
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
                onClock?.invoke(manifest?.serverNow, manifest?.interrupt)
                when (val d = differ.onFetched(manifest)) {
                    is ManifestDecision.Ignore -> {}
                    is ManifestDecision.EmitNull -> onManifest(null)
                    is ManifestDecision.Emit -> {
                        prefetch(d.manifest)
                        onManifest(d.manifest)
                    }
                }
                // After the emit: the first paint never waits behind a clip
                // that is needed at 09:00.
                prefetchInterrupt(manifest?.interrupt)
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
        // The interrupt clip is not a playlist item — without this it is evicted
        // on the next playlist change and missing at 09:00. Its own download
        // runs on every fetch via prefetchInterrupt(), not gated on Emit here;
        // this only has to keep it out of the eviction sweep below.
        val keep = m.interrupt?.sha256?.let { shas + it } ?: shas
        // Downloads are best-effort; failed shas fall back to network streaming at play time.
        mediaCache.evictExcept(keep.toSet())
    }

    /** Keep the interrupt clip cached. Runs on EVERY fetch (not gated on
     *  ManifestDecision.Emit like prefetch()) so an unchanged playlist still
     *  refreshes/keeps it — a stale schedule must not leave the box without
     *  the clip at 09:00. Never more often than [PrefetchGate] allows: a clip
     *  that never lands (storage guard, truncated CDN object) must not block
     *  this thread for a full download on every poll. */
    private fun prefetchInterrupt(i: ManifestInterrupt?) {
        val sha = i?.sha256 ?: return
        if (mediaCache.exists(sha)) { interruptGate.succeeded(sha); return }
        val now = System.currentTimeMillis()
        if (!interruptGate.shouldTry(sha, now)) return
        runCatching { mediaCache.downloadSync(sha, mediaUrl(sha)) }
        // exists() re-checked: the storage guard skips without throwing.
        if (mediaCache.exists(sha)) interruptGate.succeeded(sha)
        else interruptGate.failed(sha, System.currentTimeMillis())
    }

    fun openStream() {
        if (closed || es != null) return
        val req = Request.Builder()
            .url("$serverBaseUrl/api/devices/$deviceId/stream")
            .build()
        es = EventSources.createFactory(sseHttp).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                attempt = 0  // Healthy stream — reset backoff so SSE reconnects aren't penalised by unrelated reconcile failures.
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
                    "reload" -> (onReload ?: ::reconcile)() // NativeSurface recreates; default reconciles
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
