package ai.lanka.kiosk

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import java.util.UUID

class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web)
        configureWebView()

        val url = "${BuildConfig.LANKA_SERVER_URL}/player?deviceId=${deviceId()}"
        webView.loadUrl(url)
    }

    private fun configureWebView() {
        webView.setBackgroundColor(Color.BLACK)
        webView.webViewClient = LankaWebViewClient()
        webView.webChromeClient = LankaChromeClient()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString LankaKiosk/${BuildConfig.VERSION_NAME}"
        }
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

    companion object {
        private const val KEY_DEVICE_ID = "deviceId"
    }
}
