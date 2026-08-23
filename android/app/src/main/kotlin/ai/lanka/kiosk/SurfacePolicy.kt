package ai.lanka.kiosk

/**
 * Persisted surface choice plus the crash-loop guard's bookkeeping.
 * Absent preferences map to the defaults here, so an OTA'd box with no key
 * keeps running the WebView player.
 */
data class SurfaceState(
    val surface: SurfaceKind = SurfaceKind.WEBVIEW,
    val lastGood: SurfaceKind = SurfaceKind.WEBVIEW,
    /** Epoch ms of an unconfirmed switch; null when not guarding. */
    val pendingSince: Long? = null,
    /** Cold process starts since [pendingSince]. */
    val starts: Int = 0,
) {
    val pending: Boolean get() = pendingSince != null
}

/**
 * Pure state machine for switching surfaces and reverting a switch that cannot
 * start. No Android imports — JVM-unit-tested like KioskPin/TapChord. The
 * SharedPreferences adapter is [SurfaceStore]; the policy is all here.
 *
 * Why a guard at all: the remote flip-back travels over the command channel
 * that lives INSIDE the surface. A surface that dies on start can never
 * receive the command that would undo it.
 *
 * Why only COLD starts count: a cold start is a NEW OS PROCESS, detected by
 * SurfaceStore comparing ProcessToken.id against the stored `surface.process`
 * key. A recreate() (the switch itself, renderer-gone recovery, the native
 * `reload` command) happens inside the same process and is never counted; a
 * crash relaunched by the HOME pin, a reboot or BOOT_COMPLETED is. Counting
 * every onCreate would mistake two renderer recoveries for a crash loop.
 *
 * Why no deadline: a server outage right after a switch must not revert a
 * healthy surface. Window expiry stops guarding instead of reverting.
 */
object SurfacePolicy {
    const val WINDOW_MS = 10 * 60_000L
    const val MAX_STARTS = 3

    data class Outcome(val state: SurfaceState, val reverted: Boolean)

    /** Null when already on [target] (idempotent — the command is still acked). */
    fun requestSwitch(s: SurfaceState, target: SurfaceKind, now: Long): SurfaceState? =
        if (target == s.surface) null
        else s.copy(surface = target, pendingSince = now, starts = 0)

    fun onColdStart(s: SurfaceState, now: Long): Outcome {
        val since = s.pendingSince ?: return Outcome(s, false)
        if (now - since > WINDOW_MS) return Outcome(s.copy(pendingSince = null, starts = 0), false)
        val starts = s.starts + 1
        if (starts < MAX_STARTS) return Outcome(s.copy(starts = starts), false)
        return revert(s)
    }

    /** The surface proved healthy: it becomes the fallback for the next switch. */
    fun confirm(s: SurfaceState): SurfaceState =
        s.copy(lastGood = s.surface, pendingSince = null, starts = 0)

    /** Synchronous start failure. `reverted` tells the host whether to recreate(). */
    fun startFailed(s: SurfaceState): Outcome =
        if (s.pending) revert(s) else Outcome(s, false)

    private fun revert(s: SurfaceState): Outcome {
        val cleared = s.copy(pendingSince = null, starts = 0)
        // A flip-back requested before the first switch confirmed leaves
        // surface == lastGood: nothing to fall back to, so only stop guarding.
        return if (s.surface == s.lastGood) Outcome(cleared, false)
        else Outcome(cleared.copy(surface = s.lastGood), true)
    }
}
