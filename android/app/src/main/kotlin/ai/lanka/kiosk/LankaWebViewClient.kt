package ai.lanka.kiosk

import android.os.Build
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Drives kiosk self-recovery on top of plain logging:
 *  - a failed MAIN-FRAME load (server/tailnet not ready, transient drop) calls
 *    [onMainFrameError] so the host can retry with backoff instead of leaving a
 *    dead blank page;
 *  - a successful load calls [onPageOk] so the host can reset its retry backoff;
 *  - renderer-process death calls [onRenderGone] and returns true, so the OS
 *    does not kill the Activity and the host can rebuild the kiosk.
 */
class LankaWebViewClient(
    private val onMainFrameError: () -> Unit = {},
    private val onPageOk: () -> Unit = {},
    private val onRenderGone: () -> Unit = {},
    private val mediaCache: MediaCache? = null
) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        if (request != null) {
            mediaCache?.intercept(request)?.let { return it }
        }
        return super.shouldInterceptRequest(view, request)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        onPageOk()
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?
    ) {
        Log.e("LankaWebView", "load error ${error?.errorCode} ${error?.description} — ${request?.url}")
        // Only retry on the top-level document; a single failed media subresource
        // must not trigger a full page reload.
        if (request?.isForMainFrame == true) onMainFrameError()
    }

    override fun onRenderProcessGone(
        view: WebView?,
        detail: RenderProcessGoneDetail?
    ): Boolean {
        val didCrash =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) detail?.didCrash() else null
        Log.e("LankaWebView", "render process gone (didCrash=$didCrash) — recovering")
        onRenderGone()
        return true
    }
}
