package ai.lanka.kiosk

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The `set-surface` command, shared by both surfaces (NativeFSBridge.setSurface
 * for the WebView player, CommandActions.setSurface for the native one).
 *
 * Validate → commit the preference → recreate() the host Activity after a short
 * grace. The grace lets the ack frame leave the socket that the current surface
 * owns before that surface is torn down. Thread-safe: called from the JavaBridge
 * thread or the WebSocket thread; recreate() itself always runs on main.
 */
object SurfaceSwitcher {
    const val ACK_GRACE_MS = 500L
    private const val TAG = "LankaKiosk"
    private val main = Handler(Looper.getMainLooper())

    /** The one scheduled restart. A newer request replaces it, so back-to-back
     *  toggles end in a single recreate() that reads the final committed value.
     *  A superseded task detects it was replaced and skips. */
    private var pendingRestart: Runnable? = null

    /** Null when accepted (including "already on that surface"); else the failure reason. */
    fun request(activity: Activity, name: String): String? {
        val target = SurfaceKind.parse(name) ?: return "unknown surface '$name'"
        if (OtaInstaller.busy) return "ota in progress"
        if (!SurfaceStore(activity).requestSwitch(target)) {
            Log.i(TAG, "set-surface ${target.wire}: already active")
            return null
        }
        Log.i(TAG, "set-surface ${target.wire}: committed, restarting player in ${ACK_GRACE_MS}ms")
        scheduleRestart(activity)
        return null
    }

    @Synchronized
    private fun scheduleRestart(activity: Activity) {
        pendingRestart?.let { main.removeCallbacks(it) }
        val task = object : Runnable {
            override fun run() {
                // removeCallbacks cannot cancel a task the Looper has already
                // dequeued, so re-check identity under the lock: a superseded
                // task must skip the restart instead of erasing its successor's
                // slot and double-firing recreate().
                synchronized(this@SurfaceSwitcher) {
                    if (pendingRestart !== this) return
                    pendingRestart = null
                }
                if (!activity.isFinishing && !activity.isDestroyed) activity.recreate()
            }
        }
        pendingRestart = task
        main.postDelayed(task, ACK_GRACE_MS)
    }
}
