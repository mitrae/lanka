package ai.lanka.kiosk

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent

/** Surface-agnostic kiosk lifecycle shared by the WebView and native players. */
open class KioskActivity : Activity() {

    protected val mainHandler = Handler(Looper.getMainLooper())

    private val kioskReturnRunnable = Runnable {
        startActivity(
            Intent(this, this::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
    }

    override fun onResume() {
        super.onResume()
        // Enter lock task once the activity is foregrounded. Pins the kiosk with
        // no "screen pinned" UI when device owner; no-op otherwise. Idempotent.
        DevicePolicy.startKioskMode(this)
        // Cancel a pending snap-back — we're already in front.
        mainHandler.removeCallbacks(kioskReturnRunnable)
    }

    /**
     * Kiosk snap-back. The user pressed HOME or launched another app — bring the
     * player back to the foreground so the remote can't park on the Google TV
     * launcher. Needs SYSTEM_ALERT_WINDOW for the background activity launch
     * (granted at setup). A no-op under device-owner lock-task, which never lets
     * focus leave in the first place. Also re-foregrounds the player when the box
     * wakes from sleep.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        scheduleKioskReturn()
    }

    override fun onStop() {
        super.onStop()
        // Catch backgrounding that skipped onUserLeaveHint, but never fight our
        // own recreate() (renderer recovery) or an intentional finish.
        if (!isFinishing && !isChangingConfigurations) scheduleKioskReturn()
    }

    protected fun scheduleKioskReturn() {
        if (!KioskLock.locked) return // unlocked for maintenance — let the user leave
        mainHandler.removeCallbacks(kioskReturnRunnable)
        mainHandler.postDelayed(kioskReturnRunnable, KIOSK_RETURN_MS)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) KioskFlags.apply(this)
    }

    /** Kiosk: a single BACK press from the remote must not tear the player down
     *  (unless unlocked for maintenance). */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) return true
        return super.onKeyDown(keyCode, event)
    }

    companion object {
        private const val KIOSK_RETURN_MS = 400L
    }
}
