package ai.lanka.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

class OtaInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val commandId = intent.getLongExtra(EXTRA_COMMAND_ID, -1L)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Silent install was refused — box isn't device owner and the
            // Android-12 self-update fast path didn't apply (older API, or the
            // ROM declined). Surface the system "install update?" prompt so a
            // human with the remote can still confirm, rather than failing.
            val confirm = pendingIntent(intent)
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(confirm) }
                .onFailure { Log.w(TAG, "could not launch install prompt: ${it.message}") }
            return
        }

        val success = status == PackageInstaller.STATUS_SUCCESS
        Log.i(TAG, "OTA install result: commandId=$commandId success=$success status=$status")
        // Notify MainActivity to call back into the WebView
        OtaResultBus.notify(commandId, if (success) "acked" else "failed")
    }

    private fun pendingIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    companion object {
        const val EXTRA_COMMAND_ID = "commandId"
        private const val TAG = "OtaInstallReceiver"
    }
}
