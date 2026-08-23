package ai.lanka.kiosk

import android.content.Context
import java.util.UUID

/**
 * The persisted, per-box random device identity used by both player surfaces.
 *
 * Stored under SharedPreferences "lanka_kiosk" / key "deviceId" so the WebView
 * (`MainActivity.deviceId()`) and the native [NativeSurface] resolve the SAME
 * id across reinstalls-in-place and recreations. Generated once on first run.
 */
object DeviceId {
    private const val PREFS = "lanka_kiosk"
    private const val KEY = "deviceId"

    fun get(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }
        val fresh = UUID.randomUUID().toString()
        prefs.edit().putString(KEY, fresh).apply()
        return fresh
    }
}
