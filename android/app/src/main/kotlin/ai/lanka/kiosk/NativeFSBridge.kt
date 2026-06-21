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
    private val webView: WebView
) {

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
        OtaInstaller.get(context).downloadApk(sha256, url)

    /**
     * Triggers a silent install of the previously downloaded APK identified by
     * [sha256]. [commandId] is echoed back via `window.__otaResult(commandId,
     * status)` when the OS delivers the install result.
     */
    @JavascriptInterface
    fun installApk(sha256: String, commandId: Long): Boolean {
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
    fun getLogs(): String = try {
        val proc = Runtime.getRuntime().exec(
            arrayOf("logcat", "-d", "-t", "200", "-s",
                "LankaKiosk:*", "LankaCache:*", "NativeFS:*", "OtaInstaller:*")
        )
        proc.inputStream.bufferedReader().readText()
    } catch (e: Exception) {
        "error: ${e.message}"
    }

    /** Returns the installed APK version name (e.g. "0.1.0-poc"). */
    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    private companion object {
        private const val TAG = "NativeFS"
    }
}
