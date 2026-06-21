package ai.lanka.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

class OtaInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val commandId = intent.getLongExtra(EXTRA_COMMAND_ID, -1L)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val success = status == PackageInstaller.STATUS_SUCCESS
        Log.i(TAG, "OTA install result: commandId=$commandId success=$success status=$status")
        // Notify MainActivity to call back into the WebView
        OtaResultBus.notify(commandId, if (success) "acked" else "failed")
    }

    companion object {
        const val EXTRA_COMMAND_ID = "commandId"
        private const val TAG = "OtaInstallReceiver"
    }
}
