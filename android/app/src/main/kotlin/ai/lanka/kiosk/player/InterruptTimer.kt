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
 */
sealed class InterruptState {
    object Inactive : InterruptState()
    data class Active(val schedule: ManifestInterrupt, val offsetMs: Long) : InterruptState()
}

class InterruptTimer {
    private var schedule: ManifestInterrupt? = null
    private var offsetMs = 0L
    private var doneFor: Long? = null

    /**
     * Publish the current schedule and re-derive the clock offset. Passing null
     * withdraws the schedule without disturbing the done latch.
     */
    fun setSchedule(next: ManifestInterrupt?, serverNow: Long?, clientNow: Long) {
        if (serverNow != null) offsetMs = serverNow - clientNow
        // doneFor is deliberately never cleared here — see the TS twin. observe()
        // compares it against the CURRENT schedule's startsAt, so a stale latch is
        // already inert, and clearing it on a withdrawal would reopen the replay
        // this latch exists to prevent.
        schedule = next
    }

    fun observe(clientNow: Long): InterruptState {
        val s = schedule ?: return InterruptState.Inactive
        if (doneFor == s.startsAt) return InterruptState.Inactive
        val now = clientNow + offsetMs
        if (now < s.startsAt) return InterruptState.Inactive
        if (now >= s.endsAt) return InterruptState.Inactive
        val offset = now - s.startsAt
        // Nothing left to play: the window outlives the clip.
        if (offset >= s.durationMs) return InterruptState.Inactive
        return InterruptState.Active(s, offset)
    }

    /** Mark the current window consumed. */
    fun markDone() {
        schedule?.let { doneFor = it.startsAt }
    }
}
