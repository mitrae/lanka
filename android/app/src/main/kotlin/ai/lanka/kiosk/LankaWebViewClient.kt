package ai.lanka.kiosk

import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class LankaWebViewClient : WebViewClient() {
    override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
        Log.e("LankaWebView", "load error ${error?.errorCode} ${error?.description} — ${request?.url}")
    }
}
