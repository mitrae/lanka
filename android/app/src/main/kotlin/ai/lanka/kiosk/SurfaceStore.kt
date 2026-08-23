package ai.lanka.kiosk

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.util.UUID

/**
 * Identity of the current OS process. [SurfaceStore] compares it with the
 * stored `surface.process` key to tell a COLD start (new process: crash
 * relaunched by the HOME pin, reboot, BOOT_COMPLETED, OTA) from a recreate()
 * inside the same process (a switch, renderer recovery, the native `reload`).
 * More robust than savedInstanceState, which can be non-null after an
 * OS-restored Activity and is a framework timing detail, not process identity.
 */
object ProcessToken {
    val id: String = UUID.randomUUID().toString()
}

/**
 * SharedPreferences adapter around [SurfacePolicy]. Same prefs file as
 * [DeviceId] ("lanka_kiosk"). Every write is a synchronous commit(): the host
 * recreate()s right after a switch and a process death in between must not
 * lose it.
 *
 * All mutations run under ONE process-wide lock: MainActivity (main thread)
 * and SurfaceSwitcher (JS-bridge / WebSocket thread) each construct their own
 * instance, so instance-level synchronization would not serialize them.
 */
class SurfaceStore(
    context: Context,
    private val now: () -> Long = System::currentTimeMillis,
    private val processId: String = ProcessToken.id,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): SurfaceState = SurfaceState(
        surface = SurfaceKind.parse(prefs.getString(KEY_SURFACE, null)) ?: SurfaceKind.WEBVIEW,
        lastGood = SurfaceKind.parse(prefs.getString(KEY_LAST_GOOD, null)) ?: SurfaceKind.WEBVIEW,
        pendingSince = if (prefs.contains(KEY_PENDING_SINCE)) prefs.getLong(KEY_PENDING_SINCE, 0L) else null,
        starts = prefs.getInt(KEY_STARTS, 0),
    )

    private fun save(s: SurfaceState) {
        val e = prefs.edit()
            .putString(KEY_SURFACE, s.surface.wire)
            .putString(KEY_LAST_GOOD, s.lastGood.wire)
            .putInt(KEY_STARTS, s.starts)
        if (s.pendingSince != null) e.putLong(KEY_PENDING_SINCE, s.pendingSince) else e.remove(KEY_PENDING_SINCE)
        e.commit()
    }

    /** True when a switch was recorded; false when already on [target]. */
    fun requestSwitch(target: SurfaceKind): Boolean {
        synchronized(LOCK) {
            val next = SurfacePolicy.requestSwitch(load(), target, now()) ?: return false
            save(next)
            return true
        }
    }

    /**
     * Call from MainActivity.onCreate. A cold start is a NEW PROCESS (the stored
     * process token differs from ours); a recreate() in the same process is not
     * one. Applies the crash-loop guard and returns the surface to run.
     */
    fun onActivityCreate(): SurfaceKind {
        synchronized(LOCK) {
            val s = load()
            val coldStart = prefs.getString(KEY_PROCESS, null) != processId
            if (!coldStart) return s.surface
            prefs.edit().putString(KEY_PROCESS, processId).commit()
            val out = SurfacePolicy.onColdStart(s, now())
            if (out.state != s) save(out.state)
            if (out.reverted) {
                Log.w(TAG, "surface ${s.surface.wire} crash-looped (${s.starts + 1} cold starts in " +
                    "${SurfacePolicy.WINDOW_MS / 60_000} min) — reverted to ${out.state.surface.wire}")
            }
            return out.state.surface
        }
    }

    /** The running surface proved healthy. Idempotent; cheap to call repeatedly. */
    fun confirm() {
        synchronized(LOCK) {
            val s = load()
            if (s.pending || s.lastGood != s.surface) save(SurfacePolicy.confirm(s))
        }
    }

    /** The surface could not start. Returns true when it reverted (host should recreate()). */
    fun startFailed(): Boolean {
        synchronized(LOCK) {
            val s = load()
            val out = SurfacePolicy.startFailed(s)
            if (out.state != s) save(out.state)
            if (out.reverted) Log.w(TAG, "surface ${s.surface.wire} failed to start — reverted to ${out.state.surface.wire}")
            return out.reverted
        }
    }

    companion object {
        private val LOCK = Any()
        private const val TAG = "LankaKiosk"
        private const val PREFS = "lanka_kiosk"
        private const val KEY_SURFACE = "surface"
        private const val KEY_LAST_GOOD = "surface.lastGood"
        private const val KEY_PENDING_SINCE = "surface.pendingSince"
        private const val KEY_STARTS = "surface.starts"
        private const val KEY_PROCESS = "surface.process"
    }
}
