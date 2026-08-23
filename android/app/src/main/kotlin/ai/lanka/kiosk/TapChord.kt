package ai.lanka.kiosk

/**
 * Counts taps and fires once [taps] have landed inside a sliding [windowMs].
 * Backs the PIN pad's fallback trigger (5× BACK in 2 s) for ROMs that reserve
 * long-press BACK and IR remotes that never auto-repeat. Pure Kotlin; the
 * injected clock keeps it deterministic under test.
 */
class TapChord(
    private val taps: Int,
    private val windowMs: Long,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val times = ArrayDeque<Long>()

    /** Records a tap. Returns true (and resets) when the chord completes. */
    fun tap(): Boolean {
        val t = now()
        times.addLast(t)
        while (times.isNotEmpty() && t - times.first() > windowMs) times.removeFirst()
        if (times.size >= taps) {
            times.clear()
            return true
        }
        return false
    }
}
