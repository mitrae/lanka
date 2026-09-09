package ai.lanka.kiosk.player

/**
 * Pure decision core for the scheduled interrupt — a 1:1 port of the web
 * player's `createInterruptTimer.ts`. Keep the two test tables identical.
 *
 * Everything here exists because the box's clock cannot be trusted and the
 * network may be gone: the window arrives as an absolute epoch computed by the
 * server (no timezone or DST logic on the TV), `serverNow` supplies a
 * correction offset, and a done latch stops a backwards clock jump replaying a
 * window we already played.
 *
 * Unlike its single-threaded TS twin, the Kotlin instance is genuinely shared
 * across three threads: `setSchedule` is written from the manifest-fetch
 * thread, `observe` is read from the interrupt-tick executor, and `markDone`
 * is written from the UI thread. All three methods are `@Synchronized` rather
 * than the fields `@Volatile`, because `observe()` reads `schedule`,
 * `offsetMs` and `doneFor` together — per-field visibility alone would still
 * permit a torn read across a concurrent `setSchedule`. The failure mode a
 * torn/racy read would produce is silent: a tick that never observes on a box
 * that reports nothing wrong, which is exactly what this feature exists to
 * rule out. The lock costs nothing here — one 500 ms tick against one 30 s
 * fetch.
 */
sealed class InterruptState {
    object Inactive : InterruptState()
    data class Active(val schedule: ManifestInterrupt, val offsetMs: Long) : InterruptState()
}

class InterruptTimer {
    private var schedule: ManifestInterrupt? = null
    private var offsetMs = 0L
    private var doneFor: Long? = null
    /** startsAt of the window observe() has already reported active. Once we
     *  are IN a window, a later clock sample that pulls the corrected clock
     *  back below startsAt must not read as "not started": a 30 s poll that
     *  left at 08:59:58 and took 3 s to answer derives an offset 3 s behind
     *  the one before it, and that reading used to end the clip 1.5 s in and
     *  latch the day as done. Only endsAt (or the done latch) ends an active
     *  window. See the TS twin. */
    private var activeFor: Long? = null

    /**
     * Publish the current schedule and re-derive the clock offset. Passing null
     * withdraws the schedule without disturbing the done latch.
     */
    @Synchronized
    fun setSchedule(next: ManifestInterrupt?, serverNow: Long?, clientNow: Long) {
        if (serverNow != null) offsetMs = serverNow - clientNow
        // doneFor is deliberately never cleared here — see the TS twin. observe()
        // compares it against the CURRENT schedule's startsAt, so a stale latch is
        // already inert, and clearing it on a withdrawal would reopen the replay
        // this latch exists to prevent.
        schedule = next
    }

    @Synchronized
    fun observe(clientNow: Long): InterruptState {
        val s = schedule ?: return InterruptState.Inactive
        if (doneFor == s.startsAt) return InterruptState.Inactive
        val now = clientNow + offsetMs
        if (now >= s.endsAt) return InterruptState.Inactive
        if (now < s.startsAt) {
            if (activeFor != s.startsAt) return InterruptState.Inactive
            // Already inside this window: the clock was corrected backwards,
            // not the window withdrawn. Clamp rather than seek negative.
            return InterruptState.Active(s, 0L)
        }
        val offset = now - s.startsAt
        // Nothing left to play: the window outlives the clip.
        if (offset >= s.durationMs) return InterruptState.Inactive
        activeFor = s.startsAt
        return InterruptState.Active(s, offset)
    }

    /** `clientNow` on the server's clock — the same correction observe() uses.
     *  The overlay derives its join offset from this at seek time. */
    @Synchronized
    fun correctedNow(clientNow: Long): Long = clientNow + offsetMs

    /**
     * Mark a window consumed. Takes the `startsAt` of the window that ACTUALLY
     * played, never the currently loaded schedule's: the server rolls
     * `nextWindow` over the instant today's window ends, so a manifest poll
     * landing in the gap between that rollover and the next 500 ms tick
     * publishes TOMORROW's window — latching that on teardown would silently
     * skip tomorrow's observance on this screen. The same argument covers a
     * withdrawal mid-window (`enabled` toggled off), which leaves no schedule
     * to read a `startsAt` off at all.
     */
    @Synchronized
    fun markDone(startsAt: Long) {
        doneFor = startsAt
    }
}
