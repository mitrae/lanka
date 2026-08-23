package ai.lanka.kiosk

/**
 * Which player renders on this box. The wire name is what the dashboard sends
 * in `set-surface { surface }` and what register/telemetry report back.
 *
 * Named SurfaceKind, not Surface: `ai.lanka.kiosk.Surface` would collide with
 * `android.view.Surface` in any ExoPlayer-facing file of this package.
 */
enum class SurfaceKind(val wire: String) {
    WEBVIEW("webview"),
    NATIVE("native");

    companion object {
        /** Exact match on the wire name; null for anything else (incl. null). */
        fun parse(s: String?): SurfaceKind? = entries.firstOrNull { it.wire == s }
    }
}

/**
 * A player surface hosted by MainActivity. Exactly one exists at a time.
 *
 * Ownership rule (what makes the runtime swap safe): everything [start]
 * creates — views, WebView/ExoPlayer, sockets, SSE, executors, Handler posts,
 * OtaResultBus listener — [stop] releases. [stop] is idempotent and is called
 * from MainActivity.onDestroy (so from every recreate()).
 */
interface PlayerSurface {
    /** Build views into the host container and open the network. Main thread, once. */
    fun start()

    /** Release everything [start] created. Idempotent. */
    fun stop()
}
