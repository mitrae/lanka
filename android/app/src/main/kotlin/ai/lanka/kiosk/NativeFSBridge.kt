package ai.lanka.kiosk

import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray

/**
 * Exposes `window.NativeFS` to the WebView player so the reconciler can
 * pre-download media before building the playlist and play fully offline.
 *
 * All methods are thin delegates to [MediaCache]; the transparent interceptor
 * in [LankaWebViewClient] continues to serve Range requests from the same cache.
 */
class NativeFSBridge(private val cache: MediaCache) {

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

    private companion object {
        private const val TAG = "NativeFS"
    }
}
