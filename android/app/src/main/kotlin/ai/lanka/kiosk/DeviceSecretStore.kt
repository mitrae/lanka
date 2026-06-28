package ai.lanka.kiosk

import android.content.Context

/**
 * Persists the per-device command-channel secret. The server issues it once at
 * the first /register (trust-on-first-use) and never again, so the device must
 * keep it across reboots to authenticate the command WS. Stored in the same
 * "lanka_kiosk" SharedPreferences as [DeviceId], keyed by deviceId.
 */
object DeviceSecretStore {
    private const val PREFS = "lanka_kiosk"
    private fun key(deviceId: String) = "cmdSecret:$deviceId"

    fun get(context: Context, deviceId: String): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key(deviceId), null)

    fun put(context: Context, deviceId: String, secret: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(key(deviceId), secret).apply()
    }
}
