package ai.lanka.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.UserManager
import android.util.Log

/**
 * Wraps the device-owner capabilities the kiosk uses once Lanka has been
 * provisioned as device owner (see android/README.md):
 *
 *   adb shell dpm set-device-owner ai.lanka.kiosk/.LankaDeviceAdminReceiver
 *
 * Every method is a safe no-op when Lanka is NOT device owner, so the same APK
 * still runs on a permissive/rooted box or an un-provisioned one — it just loses
 * the silent-reboot and true lock-task guarantees and degrades to the
 * WebView-only kiosk (immersive flags + BACK swallow + self-heal reloads).
 */
object DevicePolicy {
    private const val TAG = "LankaPolicy"

    private fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private fun admin(context: Context): ComponentName =
        ComponentName(context, LankaDeviceAdminReceiver::class.java)

    fun isDeviceOwner(context: Context): Boolean =
        runCatching { dpm(context).isDeviceOwnerApp(context.packageName) }.getOrDefault(false)

    /**
     * Locks the box down to the kiosk. Device-owner only; no-op otherwise.
     * Each policy is wrapped individually so a ROM that rejects one (common on
     * cheap boxes) still gets the rest. Idempotent — safe to call every onCreate.
     *
     * - Whitelists Lanka for lock task so [startKioskMode] can pin it.
     * - Makes Lanka the persistent HOME activity (using [homeActivity]), so a
     *   reboot returns straight to the player without relying on BOOT_COMPLETED
     *   (restricted on API 29+). Pass null to skip the HOME-launcher pinning.
     * - Disables keyguard/status bar and blocks safe-boot / factory-reset so a
     *   passer-by with a remote can't escape the player.
     * - Defers OS (Google TV) updates to an overnight window so the box never
     *   reboots mid-playlist on its own.
     * - Auto-grants runtime permissions so OTA installs never stall on a prompt.
     */
    fun applyKioskPolicies(context: Context, homeActivity: Class<out Activity>? = null) {
        if (!isDeviceOwner(context)) return
        val dpm = dpm(context)
        val admin = admin(context)
        val pkg = context.packageName

        runCatching { dpm.setLockTaskPackages(admin, arrayOf(pkg)) }
            .onFailure { Log.w(TAG, "setLockTaskPackages: ${it.message}") }
        if (homeActivity != null) {
            runCatching { setHomeLauncher(context, dpm, admin, homeActivity) }
                .onFailure { Log.w(TAG, "setHomeLauncher: ${it.message}") }
        }
        runCatching { dpm.setKeyguardDisabled(admin, true) }
        runCatching { dpm.setStatusBarDisabled(admin, true) }
        runCatching { dpm.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT) }
        runCatching { dpm.addUserRestriction(admin, UserManager.DISALLOW_FACTORY_RESET) }
        runCatching {
            dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching { dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE) }
        }
        runCatching {
            // Minutes from midnight: 03:00–05:00.
            dpm.setSystemUpdatePolicy(admin, SystemUpdatePolicy.createWindowedInstallPolicy(180, 300))
        }
        Log.i(TAG, "kiosk policies applied (device owner)")
    }

    private fun setHomeLauncher(
        context: Context,
        dpm: DevicePolicyManager,
        admin: ComponentName,
        homeActivity: Class<out Activity>,
    ) {
        val filter = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        dpm.addPersistentPreferredActivity(
            admin, filter, ComponentName(context, homeActivity)
        )
    }

    /**
     * Pins the kiosk to the foreground so the remote can't escape to the Google
     * TV launcher or other apps.
     *
     * - With device owner: silent, whitelisted lock task (no prompt, no escape).
     * - WITHOUT device owner: falls back to screen pinning (startLockTask on a
     *   non-whitelisted app). While pinned the system blocks HOME / Recents /
     *   app-switch; the only escape is a deliberate Back+Recents hold. Requires
     *   screen pinning enabled (Settings.Secure lock_to_app_enabled=1).
     *
     * Guarded by the current lock-task state so onResume can call it repeatedly
     * without re-pinning / re-prompting.
     */
    fun startKioskMode(activity: Activity) {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        if (am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) return
        runCatching { activity.startLockTask() }
            .onFailure { Log.w(TAG, "startLockTask: ${it.message}") }
    }

    /** Reboots the device. Device-owner only; returns false if it couldn't. */
    fun reboot(context: Context): Boolean {
        if (!isDeviceOwner(context)) return false
        return runCatching { dpm(context).reboot(admin(context)); true }
            .onFailure { Log.w(TAG, "reboot: ${it.message}") }
            .getOrDefault(false)
    }
}
