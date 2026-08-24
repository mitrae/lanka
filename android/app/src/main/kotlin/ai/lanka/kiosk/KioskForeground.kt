package ai.lanka.kiosk

import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Re-foregrounds the player from a NON-Activity context.
 *
 * The snap-back in [KioskActivity] only fires when the player *leaves* the
 * foreground, so it cannot help a box that is already parked on the launcher —
 * e.g. after a `kiosk-unlock`, someone exits the app, and the operator then
 * sends `kiosk-lock` from the dashboard expecting the screen to come back. That
 * command arrives on a bridge/WebSocket thread with no visible Activity, and
 * before this it only re-armed the guard: the flag flipped and the TV kept
 * showing the launcher.
 *
 * Needs SYSTEM_ALERT_WINDOW for the background activity launch — the same
 * exemption the snap-back and the BOOT_COMPLETED autostart already depend on.
 * Without it the start is silently dropped by the OS, so failure here is logged
 * and swallowed rather than thrown: a command must never kill the channel.
 *
 * [MainActivity] is `launchMode="singleTask"`, so with FLAG_ACTIVITY_NEW_TASK a
 * live-but-backgrounded instance is brought forward via onNewIntent instead of
 * being recreated — playback continues rather than restarting.
 */
object KioskForeground {
    private const val TAG = "LankaKiosk"

    fun bringToFront(context: Context) {
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            )
        }.onFailure {
            // Most likely SYSTEM_ALERT_WINDOW is not granted on this box.
            Log.w(TAG, "bringToFront failed", it)
        }
    }
}
