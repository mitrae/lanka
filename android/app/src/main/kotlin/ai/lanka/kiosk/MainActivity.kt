package ai.lanka.kiosk

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import java.util.UUID

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var playerUrl: String

    private val mainHandler = Handler(Looper.getMainLooper())
    private var reloadAttempt = 0
    private var reloadPending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web)
        configureWebView()

        playerUrl = "${BuildConfig.LANKA_SERVER_URL}/player?deviceId=${deviceId()}"
        webView.loadUrl(playerUrl)
    }

    private fun configureWebView() {
        webView.setBackgroundColor(Color.BLACK)
        webView.webViewClient = LankaWebViewClient(
            onMainFrameError = { scheduleReload() },
            onPageOk = { reloadAttempt = 0 },
            onRenderGone = { recoverFromRenderGone() }
        )
        webView.webChromeClient = LankaChromeClient()
        webView.settings.apply {
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
        if (reloadPending) return
        reloadPending = true
        val delayMs = minOf(RELOAD_BASE_MS shl reloadAttempt, RELOAD_MAX_MS)
        if (reloadAttempt < RELOAD_MAX_SHIFT) reloadAttempt++
        mainHandler.postDelayed({
            reloadPending = false
            webView.loadUrl(playerUrl)
        }, delayMs)
    }

    /**
     * The WebView renderer process died (OOM, GPU/codec crash — common during
     * hours of video on low-end boxes). Without handling this, the OS kills the
     * Activity and the screen stays black. Destroy the dead WebView and rebuild
     * the Activity so the kiosk recovers on its own.
     */
    private fun recoverFromRenderGone() {
        mainHandler.removeCallbacksAndMessages(null)
        reloadPending = false
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        recreate()
    }

    private fun deviceId(): String {
        val prefs = getSharedPreferences("lanka_kiosk", Context.MODE_PRIVATE)
        prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
        val fresh = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, fresh).apply()
        return fresh
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) KioskFlags.apply(this)
    }

    /** Kiosk: a single BACK press from the remote must not tear the player down. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) return true
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        private const val KEY_DEVICE_ID = "deviceId"
        private const val RELOAD_BASE_MS = 3_000L  // first retry after 3s
        private const val RELOAD_MAX_MS = 30_000L  // cap between retries
        private const val RELOAD_MAX_SHIFT = 4     // 3,6,12,24 → then 30s cap
    }
}
