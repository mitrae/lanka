package ai.lanka.kiosk

import ai.lanka.kiosk.player.AndroidSchedulerDeps
import ai.lanka.kiosk.player.CommandActions
import ai.lanka.kiosk.player.CommandClient
import ai.lanka.kiosk.player.Manifest
import ai.lanka.kiosk.player.ManifestClient
import ai.lanka.kiosk.player.OkHttpTelemetryPoster
import ai.lanka.kiosk.player.PlaybackView
import ai.lanka.kiosk.player.Scheduler
import ai.lanka.kiosk.player.TelemetryClient
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.util.UnstableApi
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Native (ExoPlayer) player surface — the body of the pre-merge PlayerActivity,
 * hosted by [MainActivity]. The analogue of the web player's `usePlayerBoot`.
 *
 * Wires together: [ManifestClient] (register / SSE / 30s poll / prefetch),
 * [Scheduler] (timing) + [PlaybackView] (ExoPlayer A/B crossfade) per manifest,
 * [TelemetryClient] (item-start / item-failed / cleared), and one [CommandClient]
 * (reboot / screenshot / logs / kiosk-lock / OTA / reload / set-surface).
 *
 * View lifecycle: [root] holds exactly one visible child at a time — a
 * [standbyView] (before the first manifest, or on a boot-time error with
 * nothing yet played), a [noContentView] (manifest cleared / 204), or the
 * current [PlaybackView]. Each manifest releases the prior PlaybackView +
 * Scheduler and builds fresh ones, matching the web player's `:key` remount.
 *
 * Health: the first manifest callback (any manifest, even empty — it proves
 * we registered and the server talks to us) calls [onConfirmed], which the
 * crash-loop guard uses to mark this surface last-known-good.
 */
@UnstableApi
class NativeSurface(
    private val activity: Activity,
    private val root: FrameLayout,
    private val onConfirmed: () -> Unit,
    private val switchSurface: (String) -> String?,
) : PlayerSurface {

    private val handler = Handler(Looper.getMainLooper())

    private lateinit var standbyView: View
    private lateinit var noContentView: View

    private lateinit var deviceId: String
    private lateinit var http: OkHttpClient
    private lateinit var json: Json
    private lateinit var mediaCache: MediaCache
    private lateinit var telemetry: TelemetryClient

    private var manifestClient: ManifestClient? = null
    private var commandClient: CommandClient? = null

    private var playbackView: PlaybackView? = null
    private var scheduler: Scheduler? = null

    /** True once we have shown real content (a manifest), so a later transient
     *  error doesn't blank an already-playing screen back to standby. */
    private var hasPlayed = false

    @Volatile private var stopped = false

    // Network calls (register/reconcile) must not run on the UI thread.
    private val bootIo = Executors.newSingleThreadExecutor { r ->
        Thread(r, "player-boot").apply { isDaemon = true }
    }

    // Owned by this surface: created here, shut down in stop(). A leaked
    // scheduler would keep posting telemetry after a set-surface switch.
    private val visibilityExec = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "visibility-sample").apply { isDaemon = true }
    }

    override fun start() {
        deviceId = DeviceId.get(activity)

        // Shared client keeps FINITE timeouts. ManifestClient derives its own
        // infinite-read SSE client from this; ExoPlayer/telemetry use it directly.
        http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        json = Json { ignoreUnknownKeys = true }
        mediaCache = MediaCache.get(activity)

        standbyView = makeBanner("Lanka — waiting for content…")
        noContentView = makeBanner("No content scheduled")
        showStandbyIfNeverPlayed()

        telemetry = TelemetryClient(
            OkHttpTelemetryPoster(http, BuildConfig.LANKA_SERVER_URL),
            BuildConfig.VERSION_NAME,
            visibility = {
                val snap = KioskVisibility.shared.snapshot()
                val pkg = if (snap.state == KioskVisibility.State.FOREGROUND) null
                else ForegroundAppProbe.current(activity, snap.episodeMs)
                snap to pkg
            }
        )

        // Native streams media via the server `/media/:sha` proxy (mediaPublicBase
        // = ""); prefetch downloads everything, so this only falls back on a miss.
        val mc = ManifestClient(
            deviceId = deviceId,
            serverBaseUrl = BuildConfig.LANKA_SERVER_URL,
            mediaPublicBase = "",
            http = http,
            json = json,
            mediaCache = mediaCache,
            // Confirm AFTER the mount: onManifest builds PlaybackView/ExoPlayer —
            // the riskiest native code — and confirming first would disarm the
            // crash-loop guard one statement before it can crash. An empty/null
            // manifest still confirms (the branch returns normally): the signal
            // stays "registered and talking to the server".
            onManifest = { m -> onUi { onManifest(m); onConfirmed() } },
            onError = { onUi { showStandbyIfNeverPlayed() } },
            onReload = { onUi { activity.recreate() } },
            onCommandSecret = { DeviceSecretStore.put(activity, deviceId, it) }
        )
        manifestClient = mc

        // Register + start network off the UI thread (NetworkOnMainThread-safe).
        // stop() can land mid-boot (a switch while registering): shutdownNow()
        // only interrupts, and an OkHttp call in flight runs to completion, so
        // re-check between stages — otherwise we would reopen SSE/polling after
        // close(), and startPolling() on the shut-down executor would throw on
        // this thread, which on Android crashes the process.
        bootIo.execute {
            try {
                mc.register("native", PLAYER_VERSION)
                if (stopped) return@execute
                mc.reconcile()
                if (stopped) return@execute
                mc.openStream()
                if (stopped) return@execute
                mc.startPolling()
            } catch (e: Exception) {
                if (!stopped) Log.w(TAG, "native boot failed: $e")
            }
        }

        commandClient = CommandClient(
            deviceId,
            BuildConfig.LANKA_SERVER_URL,
            http,
            commandActions,
            // Stored from a prior register (TOFU). Null on the very first boot —
            // the WS connects in grace until register persists it for next time.
            secret = DeviceSecretStore.get(activity, deviceId)
        ).also { it.open() }

        // Sample cheaply and post on a real change, with the heartbeat as a
        // floor. A 30 s beat alone would miss an occlusion that starts and ends
        // between two beats. runCatching matters: an uncaught throw inside
        // scheduleWithFixedDelay silently cancels all future runs.
        var lastSeq = -1
        var lastPostAt = 0L
        visibilityExec.scheduleWithFixedDelay({
            runCatching {
                if (stopped) return@runCatching
                val seq = KioskVisibility.shared.snapshot().changeSeq
                val elapsed = System.currentTimeMillis() - lastPostAt
                if (KioskVisibility.shouldPost(seq, lastSeq, elapsed)) {
                    lastSeq = seq
                    lastPostAt = System.currentTimeMillis()
                    telemetry.heartbeat(deviceId)
                }
            }
        }, 2, 2, TimeUnit.SECONDS)
    }

    /** Hop to the UI thread; dropped once stopped (a callback can land after teardown). */
    private fun onUi(block: () -> Unit) {
        activity.runOnUiThread { if (!stopped) block() }
    }

    /** Always on the UI thread. Tear down the previous playlist and mount the new
     *  one (or the no-content view when the manifest is null/empty). */
    private fun onManifest(m: Manifest?) {
        playbackView?.let { pv ->
            root.removeView(pv)
            pv.release()
        }
        playbackView = null
        scheduler?.stop()
        scheduler = null

        if (m == null || m.items.isEmpty()) {
            showOnly(noContentView)
            telemetry.clearedCurrent(deviceId)
            return
        }

        val sched = Scheduler(m.items, AndroidSchedulerDeps(handler))
        val pv = PlaybackView(
            activity,
            mediaCache,
            fileUrlResolver = { sha ->
                if (mediaCache.exists(sha)) Uri.fromFile(mediaCache.file(sha))
                else Uri.parse("${BuildConfig.LANKA_SERVER_URL}/media/$sha")
            },
            onItemStarted = { id -> telemetry.itemStarted(deviceId, id) },
            onItemFailed = { id, sha, msg -> telemetry.itemFailed(deviceId, id, sha, msg) },
            onCleared = { telemetry.clearedCurrent(deviceId) }
        )
        scheduler = sched
        playbackView = pv
        root.addView(pv, matchParent())
        showOnly(pv)
        hasPlayed = true
        pv.bind(m, sched)
    }

    private fun showStandbyIfNeverPlayed() {
        if (!hasPlayed) showOnly(standbyView)
    }

    /** Make [view] the sole visible child of [root]. */
    private fun showOnly(view: View) {
        if (view.parent == null) root.addView(view, matchParent())
        for (i in 0 until root.childCount) {
            val child = root.getChildAt(i)
            child.visibility = if (child === view) View.VISIBLE else View.GONE
        }
    }

    private fun makeBanner(text: String): View = TextView(activity).apply {
        this.text = text
        setTextColor(Color.parseColor("#F4F4F5"))
        setBackgroundColor(Color.BLACK)
        gravity = Gravity.CENTER
        visibility = View.GONE
    }

    // ── Command channel actions (native analogue of NativeFSBridge) ──────────

    private val commandActions = object : CommandActions {
        override fun reboot(): Boolean = DevicePolicy.reboot(activity)

        override fun reload() {
            onUi { activity.recreate() }
        }

        override fun setKioskLock(enabled: Boolean) {
            KioskLock.locked = enabled
            Log.i(TAG, "kiosk lock set to $enabled")
        }

        override fun setSurface(name: String): String? = switchSurface(name)

        /** Capture the player window into a JPEG data URI. Mirrors
         *  NativeFSBridge.screenshot() but draws the player root (no WebView). */
        override fun screenshot(): String = captureScreenshot()

        /** Last 200 logcat lines filtered to Lanka tags (same as NativeFSBridge). */
        override fun getLogs(): String = try {
            val proc = Runtime.getRuntime().exec(
                arrayOf(
                    "logcat", "-d", "-t", "200", "-s",
                    "LankaKiosk:*", "LankaCache:*", "NativeFS:*",
                    "OtaInstaller:*", "CommandClient:*", TAG
                )
            )
            proc.inputStream.bufferedReader().readText()
        } catch (e: Exception) {
            "error: ${e.message}"
        }

        /** Download + silently install the OTA APK. The OS-delivered result (or an
         *  immediate failure) flows back via OtaResultBus → CommandClient's ack. */
        override fun installOta(sha256: String, url: String, commandId: Int): Boolean {
            val absUrl = if (url.startsWith("http")) url
                         else BuildConfig.LANKA_SERVER_URL.trimEnd('/') + url
            val installer = OtaInstaller.get(activity)
            if (!installer.downloadApk(sha256, absUrl)) return false
            installer.installSilently(activity, sha256, commandId.toLong()) { status ->
                OtaResultBus.notify(commandId.toLong(), status)
            }
            return true
        }
    }

    /** Draw the player root into a bitmap on the UI thread and JPEG-encode it as
     *  a data URI. Software-canvas draw (like the WebView path) so it works
     *  without a Surface handle. Empty string on failure. */
    private fun captureScreenshot(): String {
        val latch = CountDownLatch(1)
        var result = ""
        activity.runOnUiThread {
            try {
                val w = root.width.coerceAtLeast(1)
                val h = root.height.coerceAtLeast(1)
                val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(bitmap))
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
                result = "data:image/jpeg;base64," +
                    Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            } catch (e: Exception) {
                Log.w(TAG, "screenshot failed: ${e.message}")
            } finally {
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    /** Ownership rule: everything start() created goes here. Idempotent. */
    override fun stop() {
        if (stopped) return
        stopped = true
        manifestClient?.close()
        manifestClient = null
        commandClient?.close()            // also clears the OtaResultBus listener
        commandClient = null
        // Before the OkHttp shutdown below, so a tick in flight cannot enqueue
        // a call onto a closing client.
        visibilityExec.shutdownNow()
        // Release the shared OkHttp client (dispatcher threads + connection pool).
        // Graceful shutdown: manifest/command clients above are already closed.
        if (::http.isInitialized) {
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
        playbackView?.let { root.removeView(it); it.release() }
        playbackView = null
        scheduler?.stop()
        scheduler = null
        bootIo.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        if (::standbyView.isInitialized) root.removeView(standbyView)
        if (::noContentView.isInitialized) root.removeView(noContentView)
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
    )

    companion object {
        private const val TAG = "LankaKiosk"
        const val PLAYER_VERSION = "native-1"
    }
}
