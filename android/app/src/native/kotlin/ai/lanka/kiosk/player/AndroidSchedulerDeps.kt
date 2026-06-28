package ai.lanka.kiosk.player

import android.os.Handler

/**
 * [SchedulerDeps] backed by an Android main-thread [Handler], so the pure-Kotlin
 * [Scheduler] (which is JVM-unit-tested with a fake clock) can drive real image
 * dwell timers on-device. The returned handle is the [Runnable] posted, which
 * [clearTimeout] removes.
 */
class AndroidSchedulerDeps(private val handler: Handler) : SchedulerDeps {
    override fun setTimeout(cb: () -> Unit, ms: Long): Any {
        val r = Runnable { cb() }
        handler.postDelayed(r, ms)
        return r
    }

    override fun clearTimeout(handle: Any) {
        handler.removeCallbacks(handle as Runnable)
    }
}
