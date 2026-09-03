package ai.lanka.kiosk.player

/**
 * Pure stall detector for [PlaybackView] — a 1:1 port of the web player's
 * `createStallWatchdog`. Fed periodic samples of the front player's position;
 * reports a stall once the position has failed to move for the applicable
 * threshold while playback was supposed to be progressing.
 *
 * Why it exists on native too: Media3 can sit in `STATE_BUFFERING` — or in
 * `STATE_READY` with a hung Amlogic `MediaCodec` — indefinitely without ever
 * raising `onPlayerError`. Listening only for `STATE_ENDED` and errors leaves
 * a frozen frame with no event to act on, exactly the failure the web surface
 * shipped a fix for on 2026-09-03.
 *
 * Two thresholds: a cold `prepare()` legitimately reports position 0 while the
 * extractor reads the moov atom; on the CDN fallback path that can take longer
 * than a mid-clip freeze threshold, and re-preparing there throws away the
 * buffered progress and restarts the clock. A load that has never reached
 * `STATE_READY` gets [startupMs]; once it has, [playingMs].
 *
 * No Android dependencies, no clock, no Handler — the caller owns all three,
 * which keeps this JVM-testable like the other pure cores in this package.
 */
class StallWatchdog(private val startupMs: Long, private val playingMs: Long) {

    /** Single threshold for both phases. */
    constructor(thresholdMs: Long) : this(thresholdMs, thresholdMs)

    private var sinceMs: Long? = null
    private var atPositionMs = 0L

    private fun restart(nowMs: Long, positionMs: Long) {
        sinceMs = nowMs
        atPositionMs = positionMs
    }

    /**
     * @param expectPlaying false while the player is legitimately not
     *   advancing (idle, ended, no media item, not the front slot) — those
     *   stretches never count toward a stall.
     * @param started whether this load has ever reached `STATE_READY`; selects
     *   the threshold.
     * @return true when the caller should attempt recovery.
     */
    fun observe(nowMs: Long, positionMs: Long, expectPlaying: Boolean, started: Boolean = true): Boolean {
        if (!expectPlaying) {
            sinceMs = null
            return false
        }
        val since = sinceMs
        if (since == null) {
            restart(nowMs, positionMs)
            return false
        }
        // Any movement counts, including backwards: a REPEAT_MODE_ONE wrap
        // snaps the position to ~0, which is progress, not a freeze.
        if (kotlin.math.abs(positionMs - atPositionMs) > PROGRESS_EPSILON_MS) {
            restart(nowMs, positionMs)
            return false
        }
        val threshold = if (started) playingMs else startupMs
        if (nowMs - since >= threshold) {
            // Re-arm rather than latch: one recovery attempt per threshold,
            // not one per sampling tick.
            restart(nowMs, positionMs)
            return true
        }
        return false
    }

    /** Forget the window — after a retry or a media-item change. */
    fun reset() {
        sinceMs = null
    }

    private companion object {
        /** ExoPlayer positions are whole milliseconds; anything at or below
         *  this is a dead decoder's drift, not progress. */
        const val PROGRESS_EPSILON_MS = 0L
    }
}
