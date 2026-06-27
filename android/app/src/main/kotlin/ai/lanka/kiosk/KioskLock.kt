package ai.lanka.kiosk

/**
 * Process-wide kiosk-lock flag, toggled remotely via the dashboard
 * (`kiosk-lock` / `kiosk-unlock` command → NativeFSBridge.setKioskLock).
 *
 * When locked (the default), the snap-back watchdog re-foregrounds the player and
 * BACK is swallowed. When unlocked, both are disabled so an operator can leave the
 * app for maintenance. Intentionally NOT persisted: the box always boots LOCKED
 * (fail-safe) — an unlock is a temporary maintenance window for the current run.
 *
 * A plain object (not tied to the Activity lifecycle) so the bridge and any
 * recreated MainActivity instance share one value.
 */
object KioskLock {
    @Volatile
    var locked: Boolean = true
}
