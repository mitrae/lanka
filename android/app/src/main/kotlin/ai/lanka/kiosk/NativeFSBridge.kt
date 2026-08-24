package ai.lanka.kiosk

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Exposes `window.NativeFS` to the WebView player so the reconciler can
 * pre-download media before building the playlist and play fully offline.
 *
 * All methods are thin delegates to [MediaCache]; the transparent interceptor
 * in [LankaWebViewClient] continues to serve Range requests from the same cache.
 *
 * Also exposes OTA update control and device diagnostics via new methods added
 * in Plan 7: [downloadApk], [installApk], [screenshot], [getLogs], [getAppVersion].
 */
class NativeFSBridge(
    private val cache: MediaCache,
    private val context: Context,
    private val webView: WebView,
    /** Origin (BuildConfig.LANKA_SERVER_URL) allowed to call privileged methods. */
    private val trustedOrigin: String? = null,
    /** Current top-level page URL, read on a binder thread → must be thread-safe. */
    private val currentUrl: () -> String? = { null },
    /** `set-surface` handler (SurfaceSwitcher.request bound to the host Activity). Null = accepted. */
    private val switchSurface: (String) -> String? = { "not supported" }
) {

    /**
     * Privileged methods (device control / data exfil) are refused unless the
     * WebView's current top-level page is the trusted server origin, so a foreign
     * page the WebView was somehow driven to (e.g. a server redirect that bypasses
     * shouldOverrideUrlLoading) can't reboot/install/screenshot the box. When
     * trustedOrigin is unset (e.g. tests) the gate is open. Media-cache methods
     * (exists/download/fileUrl/free/evictExcept) are not gated — they only touch
     * the cache and are on the player's hot path.
     */
    private fun privilegedOriginAllowed(): Boolean {
        if (trustedOrigin == null) return true
        val ok = WebOrigin.sameOrigin(currentUrl(), trustedOrigin)
        if (!ok) Log.w(TAG, "refused privileged NativeFS call from origin ${currentUrl()}")
        return ok
    }

    @JavascriptInterface
    fun exists(sha256: String): Boolean = cache.exists(sha256)

    /**
     * Downloads [url] to local cache under [sha256], blocking until complete.
     * Returns true on success (or if already cached), false on failure.
     * Player falls back to the network URL on false.
     */
    @JavascriptInterface
    fun download(sha256: String, url: String): Boolean {
        return try {
            cache.downloadSync(sha256, url)
            true
        } catch (e: Exception) {
            Log.w(TAG, "download failed for $sha256: ${e.message}")
            false
        }
    }

    @JavascriptInterface
    fun fileUrl(sha256: String): String = cache.fileUrl(sha256)

    /**
     * Deletes every cached file whose sha256 is NOT in [sha256ListJson].
     * Call after reconciler finishes with the current manifest's sha256 set.
     * Accepts a JSON array string because @JavascriptInterface only supports primitives and String.
     */
    @JavascriptInterface
    fun evictExcept(sha256ListJson: String) {
        val keep: Set<String> = try {
            val arr = JSONArray(sha256ListJson)
            (0 until arr.length()).mapTo(HashSet()) { arr.getString(it) }
        } catch (e: Exception) {
            emptySet()
        }
        cache.evictExcept(keep)
    }

    /** Returns available bytes in internal storage. */
    @JavascriptInterface
    fun free(): Long = cache.free()

    // ── Plan 7: OTA + diagnostics ────────────────────────────────────────────

    /**
     * Downloads an APK to local storage for later silent install.
     * Blocks the JS thread until complete; returns true on success.
     */
    @JavascriptInterface
    fun downloadApk(url: String, sha256: String): Boolean =
        if (!privilegedOriginAllowed()) false
        else OtaInstaller.get(context).downloadApk(sha256, url)

    /**
     * Triggers a silent install of the previously downloaded APK identified by
     * [sha256]. [commandId] is echoed back via `window.__otaResult(commandId,
     * status)` when the OS delivers the install result.
     */
    @JavascriptInterface
    fun installApk(sha256: String, commandId: Long): Boolean {
        if (!privilegedOriginAllowed()) return false
        OtaInstaller.get(context).installSilently(context, sha256, commandId, webView)
        return true
    }

    /**
     * Captures a JPEG screenshot of the WebView and returns it as a
     * `data:image/jpeg;base64,...` string. Returns an empty string on failure.
     *
     * Draws via software canvas so it works without a Window or Surface reference.
     * The latch ensures we capture on the main thread (required by WebView) and
     * wait for the result before returning to JS.
     */
    @JavascriptInterface
    fun screenshot(): String {
        if (!privilegedOriginAllowed()) return ""
        val latch = CountDownLatch(1)
        var result = ""
        webView.post {
            try {
                val w = webView.width.coerceAtLeast(1)
                val h = webView.height.coerceAtLeast(1)
                val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                webView.draw(canvas)
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

    /**
     * Returns the last 200 logcat lines filtered to Lanka-related tags.
     * Useful for remote diagnostics from the dashboard.
     */
    @JavascriptInterface
    fun getLogs(): String {
        if (!privilegedOriginAllowed()) return ""
        return try {
            val proc = Runtime.getRuntime().exec(
                arrayOf("logcat", "-d", "-t", "200", "-s",
                    "LankaKiosk:*", "LankaCache:*", "NativeFS:*", "OtaInstaller:*")
            )
            proc.inputStream.bufferedReader().readText()
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }

    /** Returns the installed APK version name (e.g. "0.1.0-poc"). */
    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    /**
     * Current on-screen state plus kiosk counters, as the JSON the player's
     * useVisibility composable expects. Cheap by design — no UsageStats query —
     * because the player calls this on a 2 s sampling tick.
     *
     * Privileged-origin gated like the other data-returning methods.
     */
    @JavascriptInterface
    fun visibility(): String {
        if (!privilegedOriginAllowed()) return ""
        return KioskVisibility.shared.snapshot().toJson()
    }

    /**
     * The package covering the player, or "" when unknown (appop not granted,
     * ROM refused, or the most recent resume was our own). Separate from
     * [visibility] because this one runs a UsageStats query: the player calls it
     * only when a post is going out and the state is not foreground.
     *
     * @param episodeMs how long we have been hidden, so the probe can size its
     *   lookback window — a fixed short window misses the covering app entirely.
     */
    @JavascriptInterface
    fun foregroundPackage(episodeMs: Int): String {
        if (!privilegedOriginAllowed()) return ""
        return ForegroundAppProbe.current(context, episodeMs.toLong().coerceAtLeast(0L)) ?: ""
    }

    /**
     * Reboots the device. Requires Lanka to be provisioned as device owner;
     * returns false otherwise, in which case the player falls back to a soft
     * page reload (see useCommandChannel.ts). On success the box reboots, so no
     * value is meaningfully returned — the command-hub already marks reboot
     * acked on delivery.
     */
    @JavascriptInterface
    fun reboot(): Boolean =
        if (!privilegedOriginAllowed()) false else DevicePolicy.reboot(context)

    /**
     * Enables/disables the kiosk snap-back lock at runtime (dashboard maintenance
     * toggle). When disabled, HOME/app-switch are no longer re-foregrounded and
     * BACK works again, so an operator can leave the player. Not persisted — the
     * box boots locked.
     */
    @JavascriptInterface
    fun setKioskLock(enabled: Boolean) {
        if (!privilegedOriginAllowed()) return
        KioskLock.locked = enabled
        Log.i(TAG, "kiosk lock set to $enabled")
    }

    /**
     * Switches the player surface ("webview" | "native"). The choice is committed
     * to SharedPreferences and the host Activity is recreated after a short grace,
     * so the JS caller can still send its ack. Returns "" on success, else the
     * failure reason (the dashboard shows it verbatim).
     */
    @JavascriptInterface
    fun setSurface(name: String): String {
        if (!privilegedOriginAllowed()) return "forbidden"
        val reason = switchSurface(name)
        Log.i(TAG, "set-surface $name → ${reason ?: "accepted"}")
        return reason ?: ""
    }

    private companion object {
        private const val TAG = "NativeFS"
    }
}
