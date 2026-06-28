package ai.lanka.kiosk

/**
 * Pure web-origin helpers used to pin the kiosk WebView to its trusted server
 * origin: block off-origin navigation and gate the privileged `window.NativeFS`
 * methods so only the real player page (same scheme+host+port as
 * BuildConfig.LANKA_SERVER_URL) can reboot/install/screenshot/etc.
 *
 * No Android dependency — unit-tested in src/test.
 */
object WebOrigin {
    /** scheme://host:port (port defaulted per scheme), or null if [url] has no host. */
    fun originOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return try {
            val u = java.net.URI(url)
            val scheme = u.scheme?.lowercase() ?: return null
            val host = u.host?.lowercase() ?: return null
            val port = if (u.port == -1) defaultPort(scheme) else u.port
            if (port == -1) return null
            "$scheme://$host:$port"
        } catch (_: Exception) {
            null
        }
    }

    /** True iff both URLs parse to the same scheme+host+port. Unparseable/null → false. */
    fun sameOrigin(a: String?, b: String?): Boolean {
        val oa = originOf(a) ?: return false
        val ob = originOf(b) ?: return false
        return oa == ob
    }

    private fun defaultPort(scheme: String): Int = when (scheme) {
        "http" -> 80
        "https" -> 443
        else -> -1
    }
}
