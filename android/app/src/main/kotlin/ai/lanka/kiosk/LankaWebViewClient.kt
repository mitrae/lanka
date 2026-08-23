package ai.lanka.kiosk

import android.graphics.Bitmap
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
 *  - a load that finished without a main-frame error calls [onPageOk] so the
 *    host can reset its retry backoff (and confirm the surface healthy);
 *  - renderer-process death calls [onRenderGone] and returns true, so the OS
 *    does not kill the Activity and the host can rebuild the kiosk.
 */
class LankaWebViewClient(
    private val onMainFrameError: () -> Unit = {},
    private val onPageOk: () -> Unit = {},
    private val onRenderGone: () -> Unit = {},
    private val mediaCache: MediaCache? = null,
    /** When set, top-level navigation off this origin is blocked. */
    private val trustedOrigin: String? = null
) : WebViewClient() {

    /**
     * The current top-level page URL, updated on the UI thread. NativeFSBridge
     * reads this (it can't call webView.getUrl() from its binder thread) to gate
     * privileged calls to the trusted origin.
     */
    @Volatile
    var currentUrl: String? = null
        private set

    /** Set by a main-frame network or HTTP (≥400) error during the current navigation;
     *  reset on the next onPageStarted. onPageOk fires only when it is clear. */
    private var mainFrameFailed = false

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?
    ): Boolean {
        // Pin the top-level document to the trusted server origin: a redirect or
        // injected link to an attacker page must not be able to replace the player
        // (and reach window.NativeFS). Subresources/iframes are unaffected (they
        // don't pass through here as main-frame loads) so embedded content works.
        if (trustedOrigin != null && request?.isForMainFrame == true) {
            val target = request.url?.toString()
            if (!WebOrigin.sameOrigin(target, trustedOrigin)) {
                Log.w("LankaWebView", "blocked off-origin navigation to $target")
                return true // handled → do not load
            }
        }
        return false
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        if (request != null) {
            mediaCache?.intercept(request)?.let { return it }
        }
        return super.shouldInterceptRequest(view, request)
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        mainFrameFailed = false
        currentUrl = url
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        currentUrl = url
        if (!mainFrameFailed) onPageOk()
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?
    ) {
        Log.e("LankaWebView", "load error ${error?.errorCode} ${error?.description} — ${request?.url}")
        // Only retry on the top-level document; a single failed media subresource
        // must not trigger a full page reload.
        if (request?.isForMainFrame == true) {
            mainFrameFailed = true
            onMainFrameError()
        }
    }

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        errorResponse: WebResourceResponse?
    ) {
        // A 4xx/5xx DOCUMENT (server mid-deploy, nginx 502) is not a healthy
        // player either: back off and retry like a network error.
        if (request?.isForMainFrame == true && (errorResponse?.statusCode ?: 0) >= 400) {
            Log.e("LankaWebView", "main-frame HTTP ${errorResponse?.statusCode} — ${request.url}")
            mainFrameFailed = true
            onMainFrameError()
        }
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
