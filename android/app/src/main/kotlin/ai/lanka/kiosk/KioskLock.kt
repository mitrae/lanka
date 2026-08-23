package ai.lanka.kiosk

/**
 * Process-wide kiosk-lock flag, toggled remotely via the dashboard
 * (`kiosk-lock` / `kiosk-unlock` command → NativeFSBridge.setKioskLock) or
 * locally by the on-device PIN pad (see KioskPin / PinPadView).
 *
 * When locked (the default), the snap-back watchdog re-foregrounds the player and
 * BACK is swallowed. When unlocked, both are disabled so an operator can leave the
 * app for maintenance. Intentionally NOT persisted: the box always boots LOCKED
 * (fail-safe) — an unlock is a temporary maintenance window for the current run.
 *
 * [listener] lets the foreground KioskActivity mirror the flag into real
 * lock-task state, so an unlock from ANY source (dashboard or PIN pad) actually
 * releases the pin. Without it the flag and the OS disagree on a device-owner
 * box: BACK starts working but the task stays pinned.
 *
 * The listener receives the value that was just assigned, but observers should
 * RE-READ [locked] when they act (KioskActivity does): a callback posted to the
 * main thread may run after a later assignment, and applying the captured
 * value would then roll state backwards.
 *
 * A plain object (not tied to the Activity lifecycle) so the bridge and any
 * recreated MainActivity instance share one value.
 */
object KioskLock {
    /** Invoked with the new value whenever [locked] is assigned. */
    @Volatile
    var listener: ((Boolean) -> Unit)? = null

    @Volatile
    var locked: Boolean = true
        set(value) {
            field = value
            listener?.invoke(value)
        }
}
