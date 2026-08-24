package ai.lanka.kiosk

/**
 * Process-wide record of whether the player is actually ON SCREEN, and of how
 * hard the kiosk had to fight to keep it there.
 *
 * Three states, because the two ways of losing the screen need different
 * operator responses:
 *   FOREGROUND — started, resumed and focused; genuinely visible.
 *   OBSCURED   — started but paused or unfocused, i.e. a dialog or translucent
 *                overlay is on top. The snap-back watchdog never fires for this
 *                case (no onStop), so the player can sit behind a system prompt
 *                indefinitely.
 *   BACKGROUND — not started; another app owns the screen.
 *
 * Deriving BACKGROUND from onStop alone would be wrong: an Activity stops being
 * resumed at onPause, which a translucent overlay triggers WITHOUT ever calling
 * onStop. Focus loss usually accompanies it, but "usually" is not a contract.
 *
 * Born BACKGROUND with every flag false, so a process launched into the
 * background never claims the screen. That costs nothing on a normal boot:
 * recovery to FOREGROUND is not debounced.
 *
 * Debouncing is ONE-DIRECTIONAL and scoped to the EPISODE — the unbroken stretch
 * of not being foreground. Leaving FOREGROUND is only reported once the episode
 * has lasted [DEBOUNCE_MS], comfortably past the 400 ms snap-back, so the badge
 * never flickers on a blip. The episode clock does NOT restart when the state
 * moves between OBSCURED and BACKGROUND — otherwise a focus loss followed 1.9 s
 * later by an onStop would hide a continuously-covered player for nearly four
 * seconds. Returning to foreground is reported immediately. Counters are never
 * debounced — a snap-back war is exactly what they exist to reveal.
 *
 * One process-wide instance ([shared]) serves BOTH player surfaces and survives
 * the recreate() of a set-surface switch, so the counters are process totals
 * rather than resetting with every switch.
 *
 * Every public method is synchronized: mutators run on the main thread, but
 * snapshot() is called from the WebView's JavaBridge thread (WebView surface)
 * and from the sampling scheduler thread (native surface).
 *
 * Pure Kotlin with an injected clock and no Android imports, so it is
 * JVM-unit-testable — same shape as [KioskPin].
 */
class KioskVisibility(private val now: () -> Long = System::currentTimeMillis) {

    enum class State(val wire: String) {
        FOREGROUND("foreground"),
        OBSCURED("obscured"),
        BACKGROUND("background")
    }

    data class Snapshot(
        val state: State,
        val snapBacks: Int,
        val focusLosses: Int,
        val hiddenMs: Long,
        /** Length of the current non-foreground episode; 0 when foreground.
         *  ForegroundAppProbe sizes its UsageStats query window from this. */
        val episodeMs: Long,
        /** Bumped whenever the REPORTABLE state changes, so the sampling tick can
         *  post on a change without re-deriving one itself. */
        val changeSeq: Int
    ) {
        /**
         * The bridge contract, hand-rolled so the pure core stays
         * dependency-free. Deliberately carries no foregroundPackage: the probe
         * is comparatively expensive and is fetched separately, only when a post
         * is actually going out.
         */
        fun toJson(): String =
            "{\"visibility\":\"${state.wire}\",\"snapBacks\":$snapBacks," +
                "\"focusLosses\":$focusLosses,\"hiddenMs\":$hiddenMs," +
                "\"episodeMs\":$episodeMs,\"changeSeq\":$changeSeq}"
    }

    private var started = false
    private var resumed = false
    private var focused = false

    private var raw = State.BACKGROUND

    /** Start of the current non-foreground episode; null while foreground. */
    private var episodeSince: Long? = now()
    private var stable = State.BACKGROUND
    private var changeSeq = 0

    private var lastAccrualAt = now()

    private var snapBacks = 0
    private var focusLosses = 0
    private var hiddenMs = 0L

    @Synchronized
    fun onStarted() = mutate { started = true }

    @Synchronized
    fun onResumed() = mutate { started = true; resumed = true }

    @Synchronized
    fun onPaused() = mutate { resumed = false }

    @Synchronized
    fun onStopped() = mutate { started = false; resumed = false }

    @Synchronized
    fun onFocusChanged(hasFocus: Boolean) = mutate {
        if (!hasFocus) focusLosses++
        focused = hasFocus
    }

    /** Called once per departure, after the KioskLock check — an unlocked box
     *  arms no return, and one HOME press must not count twice. */
    @Synchronized
    fun onSnapBackScheduled() {
        snapBacks++
    }

    @Synchronized
    fun snapshot(): Snapshot {
        val t = now()
        accrue(t)
        val episodeStart = episodeSince
        val effective = when {
            raw == State.FOREGROUND -> raw
            episodeStart != null && t - episodeStart >= DEBOUNCE_MS -> raw
            else -> stable
        }
        promote(effective)
        return Snapshot(
            state = effective,
            snapBacks = snapBacks,
            focusLosses = focusLosses,
            hiddenMs = hiddenMs,
            episodeMs = if (episodeStart == null) 0L else (t - episodeStart).coerceAtLeast(0L),
            changeSeq = changeSeq
        )
    }

    /** One timestamp per operation, shared by accrual and recomputation. */
    private inline fun mutate(block: () -> Unit) {
        val t = now()
        accrue(t)
        block()
        recompute(t)
    }

    /**
     * Charges elapsed time to hiddenMs when the RAW state is not foreground.
     * Negative deltas are dropped rather than subtracted: System.currentTimeMillis
     * jumps when NTP corrects the clock, which is routine on these boxes shortly
     * after boot.
     */
    private fun accrue(t: Long) {
        val delta = t - lastAccrualAt
        if (raw != State.FOREGROUND && delta > 0) hiddenMs += delta
        lastAccrualAt = t
    }

    private fun recompute(t: Long) {
        val next = when {
            !started -> State.BACKGROUND
            !resumed || !focused -> State.OBSCURED
            else -> State.FOREGROUND
        }
        if (next == raw) return
        raw = next
        // Episode boundaries only — a move BETWEEN the two hidden states keeps
        // the original episode start, so the debounce is not restarted.
        if (next == State.FOREGROUND) {
            episodeSince = null
            // Recovery is immediately reportable, so promote it HERE rather than
            // waiting for a snapshot(). Leaving it to snapshot() meant a
            // foreground stretch nobody sampled left `stable` holding the old
            // hidden state, which the next debounce window would then report.
            promote(State.FOREGROUND)
        } else if (episodeSince == null) {
            episodeSince = t
        }
    }

    /** Records the reportable state, counting a change so the transport posts. */
    private fun promote(s: State) {
        if (s == stable) return
        stable = s
        changeSeq++
    }

    companion object {
        const val DEBOUNCE_MS = 2_000L
        const val HEARTBEAT_MS = 30_000L

        /** Transport rule, shared by both surfaces and mirrored in TypeScript. */
        fun shouldPost(seq: Int, lastSeq: Int, sinceLastPostMs: Long): Boolean =
            seq != lastSeq || sinceLastPostMs >= HEARTBEAT_MS

        /** The instance the player uses. Tests construct their own with a fake clock. */
        @JvmField
        val shared = KioskVisibility()
    }
}
