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

    /**
     * Mirrors KioskLock into real lock-task state so an unlock from ANY source
     * (dashboard command or PIN pad) takes effect.
     *
     * Runs inline when already on the main thread and hops the handler otherwise:
     * startLockTask/stopLockTask are main-thread-only, but the dashboard path sets
     * the flag off-thread (NativeFSBridge on a JavaBridge thread, the native
     * CommandDispatcher on the WebSocket thread). Running inline on the main
     * thread also guarantees ordering for the PIN unlock, which must release the
     * pin BEFORE it can startActivity() to another package.
     */
    private val lockListener: (Boolean) -> Unit = {
        if (Looper.myLooper() == Looper.getMainLooper()) applyLockState()
        else mainHandler.post { applyLockState() }
    }

    /**
     * Applies the CURRENT flag — re-read here, never captured — so a post queued
     * before a later assignment cannot roll state backwards. Bails unless this
     * Activity is still the registered observer, so a post that lands after
     * onPause never pins/unpins a backgrounded instance.
     */
    private fun applyLockState() {
        if (KioskLock.listener !== lockListener || isFinishing) return
        if (KioskLock.locked) DevicePolicy.startKioskMode(this)
        else DevicePolicy.stopKioskMode(this)
    }

    override fun onResume() {
        super.onResume()
        KioskLock.listener = lockListener
        // Reconcile UNCONDITIONALLY. A dashboard unlock that arrived while we
        // were paused fired with no listener registered; an `if (locked)` guard
        // here would skip it and leave the task pinned with the flag saying
        // unlocked. This also recovers from onDestroy/renderer-recovery wiping
        // mainHandler, which drops any queued lock-state post.
        applyLockState()
        // Cancel a pending snap-back — we're already in front.
        mainHandler.removeCallbacks(kioskReturnRunnable)
    }

    override fun onPause() {
        super.onPause()
        // Clear only OUR listener — never silently deregister another instance's.
        if (KioskLock.listener === lockListener) KioskLock.listener = null
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
