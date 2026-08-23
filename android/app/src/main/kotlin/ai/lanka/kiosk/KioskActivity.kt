package ai.lanka.kiosk

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup

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
        hidePinPad()
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

    /**
     * Kiosk: a single BACK press from the remote must not tear the player down
     * (unless unlocked for maintenance). Two gestures open the PIN pad:
     *  - a LONG press — startTracking() is what makes onKeyLongPress fire at all;
     *  - five quick taps — for ROMs that reserve long-BACK (the app never sees a
     *    repeat) and IR remotes that emit discrete presses instead of holding.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) {
            if (event != null && event.repeatCount == 0) {
                event.startTracking()
                if (backTaps.tap()) showPinPad()
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) {
            showPinPad()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) return true
        return super.onKeyUp(keyCode, event)
    }

    private var pinPad: PinPadView? = null
    private val backTaps = TapChord(taps = 5, windowMs = 2_000L)
    private val pinPadTimeout = Runnable { hidePinPad() }

    /**
     * MODAL routing: while the pad is showing, every key goes to it and nothing
     * else — super is deliberately not called, so nothing leaks to the WebView
     * or the player. Activity.dispatchKeyEvent is the entry point for every
     * hardware key in the window, ahead of the view hierarchy, so this cannot
     * be starved by focus sitting elsewhere. The idle timer restarts only on an
     * accepted initial press (not repeats, not UP).
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val pad = pinPad ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            mainHandler.removeCallbacks(pinPadTimeout)
            mainHandler.postDelayed(pinPadTimeout, PIN_PAD_IDLE_MS)
        }
        return pad.handleKey(event)
    }

    private fun showPinPad() {
        if (pinPad != null) return
        // No -PKIOSK_PIN at build time → no escape hatch. Fail safe, silently.
        if (!kioskPin.enabled) return

        kioskPin.reset() // clear any stale partial entry; failure state is kept
        val pad = PinPadView(this, kioskPin, onUnlock = ::onPinAccepted, onDismiss = ::hidePinPad)
        addContentView(
            pad,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        pinPad = pad
        mainHandler.postDelayed(pinPadTimeout, PIN_PAD_IDLE_MS)
    }

    private fun hidePinPad() {
        mainHandler.removeCallbacks(pinPadTimeout)
        pinPad?.let { (it.parent as? ViewGroup)?.removeView(it) }
        pinPad = null
    }

    /**
     * Order matters: the flag assignment runs the lock listener INLINE (we are on
     * the main thread), so lock task is released before startActivity — launching
     * another package while pinned is blocked. The release is then VERIFIED:
     * stopLockTask() can be refused (ownership, OEM), and an escape hatch must
     * never silently no-op. On failure the flag is restored to locked so it never
     * disagrees with the OS; the pad stays up with a message and re-entering the
     * PIN retries the release.
     */
    private fun onPinAccepted() {
        KioskLock.locked = false
        if (DevicePolicy.isLockTaskActive(this)) {
            // stopLockTask() was refused (ownership / OEM). Keep the flag and the OS
            // in agreement: a false flag would drop BACK-swallow and snap-back on a
            // box that is still pinned, and no resume will come to retry while the
            // task is pinned and foreground. The pad stays up; re-entering the PIN
            // retries the release.
            KioskLock.locked = true
            Log.w(TAG, "lock task still active after unlock — kept locked; Settings launch would be blocked")
            pinPad?.showMessage("Unlock failed — lock task still active")
            return
        }
        hidePinPad()
        Log.i(TAG, "kiosk unlocked via on-device PIN")
        runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
            .onFailure { Log.w(TAG, "settings launch failed: ${it.message}") }
    }

    companion object {
        private const val KIOSK_RETURN_MS = 400L
        private const val PIN_PAD_IDLE_MS = 20_000L
        private const val TAG = "LankaKiosk"

        /**
         * ONE per process. The pad is recreated on every open, but the failure
         * counter and lockout must survive that — and survive Activity recreation
         * (renderer-gone recovery) — or closing and reopening the pad hands out
         * five fresh attempts every time.
         */
        private val kioskPin: KioskPin by lazy {
            KioskPin(BuildConfig.KIOSK_PIN_SHA256, BuildConfig.KIOSK_PIN_LENGTH)
        }
    }
}
