package ai.lanka.kiosk

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * WebView player surface — the body of the pre-merge MainActivity, hosted by
 * [MainActivity]. Loads `/player?deviceId=…` and exposes `window.NativeFS`;
 * the Nuxt page is the player (reconciler, scheduler, telemetry, command WS).
 *
 * Health: a CLEAN main-frame load ([LankaWebViewClient.onPageOk]) calls
 * [onConfirmed]. A renderer death BEFORE that first clean load calls
 * [onStartFailed] instead of plain recreate(): a recreate() is not a cold
 * start for the crash-loop guard, so without this a freshly switched box whose
 * WebView renderer can't survive the initial load would loop forever.
 */
class WebViewSurface(
    private val activity: Activity,
    private val container: FrameLayout,
    private val onConfirmed: () -> Unit,
    private val onStartFailed: () -> Unit,
    private val switchSurface: (String) -> String?,
) : PlayerSurface {

    private val handler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private lateinit var playerUrl: String

    private var reloadAttempt = 0
    private var reloadPending = false
    private var confirmed = false
    private var stopped = false

    override fun start() {
        val wv = WebView(activity)
        webView = wv
        container.addView(
            wv,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        configure(wv)

        OtaResultBus.setListener { commandId, status ->
            handler.post { webView?.evaluateJavascript("window.__otaResult($commandId, '$status')", null) }
        }

        playerUrl = "${BuildConfig.LANKA_SERVER_URL}/player?deviceId=${DeviceId.get(activity)}"
        wv.loadUrl(playerUrl)
    }

    private fun configure(wv: WebView) {
        wv.setBackgroundColor(Color.BLACK)
        // Create the client first: it tracks the current top-level URL, which the
        // NativeFS bridge reads to gate privileged calls to the trusted origin.
        val client = LankaWebViewClient(
            onMainFrameError = { scheduleReload() },
            onPageOk = { reloadAttempt = 0; confirmed = true; onConfirmed() },
            onRenderGone = { recoverFromRenderGone() },
            mediaCache = MediaCache.get(activity),
            trustedOrigin = BuildConfig.LANKA_SERVER_URL
        )
        wv.webViewClient = client
        wv.addJavascriptInterface(
            NativeFSBridge(
                MediaCache.get(activity), activity, wv,
                trustedOrigin = BuildConfig.LANKA_SERVER_URL,
                currentUrl = { client.currentUrl },
                switchSurface = switchSurface
            ),
            "NativeFS"
        )
        wv.webChromeClient = LankaChromeClient()
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString LankaKiosk/${BuildConfig.VERSION_NAME}"
        }
    }

    /**
     * The main player document failed to load — server or tailnet not ready at
     * boot, or a transient drop. Retry with capped exponential backoff so the
     * box heals itself instead of sitting on a blank page until someone visits.
     * Reset on a successful load via [LankaWebViewClient.onPageFinished].
     */
    private fun scheduleReload() {
        if (reloadPending || stopped) return
        reloadPending = true
        val delayMs = minOf(RELOAD_BASE_MS shl reloadAttempt, RELOAD_MAX_MS)
        if (reloadAttempt < RELOAD_MAX_SHIFT) reloadAttempt++
        handler.postDelayed({
            reloadPending = false
            webView?.loadUrl(playerUrl)
        }, delayMs)
    }

    /**
     * The WebView renderer process died (OOM, GPU/codec crash — common during
     * hours of video on low-end boxes). Without handling this, the OS kills the
     * Activity and the screen stays black. Tear down the dead WebView and rebuild
     * the host Activity so the kiosk recovers on its own.
     *
     * Before the first clean page load this is a START failure (the host reverts
     * a pending switch, then restarts either way); after it, the ordinary
     * mid-run recovery the WebView kiosk always had.
     */
    private fun recoverFromRenderGone() {
        if (stopped) return // already torn down by onDestroy — nothing to recover
        stop()
        if (confirmed) activity.recreate() else onStartFailed()
    }

    /** Ownership rule: everything start() created goes here. Idempotent. */
    override fun stop() {
        if (stopped) return
        stopped = true
        OtaResultBus.clearListener()
        handler.removeCallbacksAndMessages(null)
        reloadPending = false
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
    }

    companion object {
        private const val RELOAD_BASE_MS = 3_000L  // first retry after 3s
        private const val RELOAD_MAX_MS = 30_000L  // cap between retries
        private const val RELOAD_MAX_SHIFT = 4     // 3,6,12,24 → then 30s cap
    }
}
