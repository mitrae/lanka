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
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
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
 * Native (ExoPlayer) player entry point — the analogue of the WebView player's
 * `usePlayerBoot` + `MainActivity`.
 *
 * Wires together: [ManifestClient] (register / SSE / 30s poll / prefetch),
 * [Scheduler] (timing) + [PlaybackView] (ExoPlayer A/B crossfade) per manifest,
 * [TelemetryClient] (item-start / item-failed / cleared), and one [CommandClient]
 * (reboot / screenshot / logs / kiosk-lock / OTA / reload).
 *
 * Surface lifecycle: a root [FrameLayout] holds exactly one of three children at
 * a time — a [standbyView] (before the first manifest, or on a boot-time error
 * with nothing yet played), a [noContentView] (manifest cleared / 204), or the
 * current [PlaybackView]. Each manifest releases the prior PlaybackView+Scheduler
 * and builds fresh ones, matching the web player's `:key`-driven remount.
 */
@UnstableApi
class PlayerActivity : KioskActivity() {

    private lateinit var root: FrameLayout
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

    // Network calls (register/reconcile) must not run on the UI thread.
    private val bootIo = Executors.newSingleThreadExecutor { r ->
        Thread(r, "player-boot").apply { isDaemon = true }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        DevicePolicy.applyKioskPolicies(this, PlayerActivity::class.java)

        deviceId = DeviceId.get(this)

        // Shared client keeps FINITE timeouts. ManifestClient derives its own
        // infinite-read SSE client from this; ExoPlayer/telemetry use it directly.
        http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        json = Json { ignoreUnknownKeys = true }
        mediaCache = MediaCache.get(this)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)
        standbyView = makeBanner("Lanka — waiting for content…")
        noContentView = makeBanner("No content scheduled")
        showStandbyIfNeverPlayed()

        telemetry = TelemetryClient(
            OkHttpTelemetryPoster(http, BuildConfig.LANKA_SERVER_URL),
            BuildConfig.VERSION_NAME
        )

        // Native streams media via the server `/media/:sha` proxy (mediaPublicBase
        // = ""); prefetch downloads everything, so this only falls back on a miss.
        val manifestClient = ManifestClient(
            deviceId = deviceId,
            serverBaseUrl = BuildConfig.LANKA_SERVER_URL,
            mediaPublicBase = "",
            http = http,
            json = json,
            mediaCache = mediaCache,
            onManifest = { m -> runOnUiThread { onManifest(m) } },
            onError = { runOnUiThread { showStandbyIfNeverPlayed() } },
            onReload = { runOnUiThread { recreate() } }
        )
        this.manifestClient = manifestClient

        // Register + start network off the UI thread (NetworkOnMainThread-safe).
        bootIo.execute {
            manifestClient.register("native", PLAYER_VERSION)
            manifestClient.reconcile()
            manifestClient.openStream()
            manifestClient.startPolling()
        }

        commandClient = CommandClient(
            deviceId,
            BuildConfig.LANKA_SERVER_URL,
            http,
            commandActions
        ).also { it.open() }
    }

    /** Always invoked on the UI thread. Tear down the previous playlist and mount
     *  the new one (or the no-content view when the manifest is null/empty). */
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

        val sched = Scheduler(m.items, AndroidSchedulerDeps(mainHandler))
        val pv = PlaybackView(
            this,
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

    /** Make [view] the sole visible child of [root] (keeps any PlaybackView in the
     *  tree only while it's the active child). */
    private fun showOnly(view: View) {
        if (view.parent == null) root.addView(view, matchParent())
        for (i in 0 until root.childCount) {
            val child = root.getChildAt(i)
            child.visibility = if (child === view) View.VISIBLE else View.GONE
        }
    }

    private fun makeBanner(text: String): View = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#F4F4F5"))
        setBackgroundColor(Color.BLACK)
        gravity = Gravity.CENTER
        visibility = View.GONE
    }

    // ── Command channel actions (native analogue of NativeFSBridge) ──────────

    private val commandActions = object : CommandActions {
        override fun reboot(): Boolean = DevicePolicy.reboot(this@PlayerActivity)

        override fun reload() {
            runOnUiThread { recreate() }
        }

        override fun setKioskLock(enabled: Boolean) {
            KioskLock.locked = enabled
            Log.i(TAG, "kiosk lock set to $enabled")
        }

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
            val installer = OtaInstaller.get(this@PlayerActivity)
            if (!installer.downloadApk(sha256, url)) return false
            installer.installSilently(this@PlayerActivity, sha256, commandId.toLong()) { status ->
                OtaResultBus.notify(commandId.toLong(), status)
            }
            return true
        }
    }

    /** Draw the player root view into a bitmap on the UI thread and JPEG-encode
     *  it as a data URI. Software-canvas draw (like the WebView path) so it works
     *  without a Surface handle. Empty string on failure. */
    private fun captureScreenshot(): String {
        val latch = CountDownLatch(1)
        var result = ""
        runOnUiThread {
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

    override fun onDestroy() {
        manifestClient?.close()
        commandClient?.close()
        playbackView?.release()
        scheduler?.stop()
        bootIo.shutdownNow()
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
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
