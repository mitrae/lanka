package ai.lanka.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Relaunches the kiosk after a power cycle so an unattended box returns to
 * playback without anyone opening the app. Covers the common case (power
 * outage, scheduled overnight off, OS-update reboot).
 *
 * Note: Android 10+ restricts background activity launches from BOOT_COMPLETED;
 * on stricter boxes the robust fallback is to set Lanka as the device's HOME
 * launcher (see android/README.md).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Log.i("LankaBoot", "BOOT_COMPLETED — launching kiosk")
        val launch = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(launch)
    }
}
