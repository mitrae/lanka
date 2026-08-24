package ai.lanka.kiosk

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context

/**
 * Names whatever app is sitting on top of the player.
 *
 * UsageStats is the only source for this on modern Android: getRunningTasks is
 * restricted and getRunningAppProcesses returns only our own process. It needs
 * the PACKAGE_USAGE_STATS appop, granted per box over ADB alongside the appops
 * already in android/README.md:
 *
 *   adb shell appops set ai.lanka.kiosk GET_USAGE_STATS allow
 *
 * Without the grant queryEvents yields nothing and this returns null — the
 * dashboard then says "covered by unknown app" rather than breaking. Every call
 * is guarded, because some ROMs throw here even with the appop set.
 *
 * Sampled ONLY when a post is actually going out and we are not in the
 * foreground — never on the playback hot path and never on the 2 s sampling tick.
 */
object ForegroundAppProbe {

    /** Extra lookback beyond the episode, covering scheduler jitter and doze. */
    private const val SLACK_MS = 15_000L

    /** Never query less than this, so a just-started episode still finds its event. */
    private const val MIN_WINDOW_MS = 30_000L

    /** Never query more than this — a box hidden for days must not scan forever. */
    private const val MAX_WINDOW_MS = 6L * 60 * 60 * 1_000

    /**
     * @param episodeMs how long we have been non-foreground, from
     *   KioskVisibility.Snapshot.episodeMs. The window is derived from it: a
     *   fixed short lookback would miss the covering app entirely, because the
     *   MOVE_TO_FOREGROUND event fires once, when the intruder appears — which
     *   may be long before the post that asks about it.
     */
    fun current(context: Context, episodeMs: Long): String? = runCatching {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return null
        val end = System.currentTimeMillis()
        val window = (episodeMs + SLACK_MS).coerceIn(MIN_WINDOW_MS, MAX_WINDOW_MS)
        val events = usm.queryEvents(end - window, end)
        val event = UsageEvents.Event()
        var latestPkg: String? = null
        var latestTs = Long.MIN_VALUE
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            // MOVE_TO_FOREGROUND and ACTIVITY_RESUMED are the same constant (1);
            // the latter is just its API 29+ name.
            @Suppress("DEPRECATION")
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND &&
                event.packageName != null &&
                event.timeStamp >= latestTs
            ) {
                latestTs = event.timeStamp
                latestPkg = event.packageName
            }
        }
        // Take the most recent resume OVERALL and reject it if it is us. Scanning
        // for the latest non-Lanka event instead would blame a stale, unrelated
        // app whenever Lanka had since resumed, or when an own-app dialog stole
        // focus with no other app involved.
        if (latestPkg == null || latestPkg == context.packageName) null else latestPkg
    }.getOrNull()
}
