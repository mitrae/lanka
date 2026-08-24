package ai.lanka.kiosk.player

import ai.lanka.kiosk.KioskVisibility
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

interface TelemetryPoster { fun post(deviceId: String, jsonBody: String) }

class TelemetryClient(
    private val poster: TelemetryPoster,
    private val apkVersion: String,
    private val surface: String = "native",
    /** Supplies the current on-screen state and the covering package, if any.
     *  Null in tests and on any build that does not report visibility. */
    private val visibility: (() -> Pair<KioskVisibility.Snapshot, String?>)? = null
) {
    /** Attached inside the shared builders so no call site can forget it. */
    private fun JsonObjectBuilder.putVisibility() {
        val (snap, pkg) = visibility?.invoke() ?: return
        put("visibility", snap.state.wire)
        put("foregroundPackage", pkg?.let { JsonPrimitive(it) } ?: JsonNull)
        put("snapBacks", snap.snapBacks)
        put("focusLosses", snap.focusLosses)
        put("hiddenMs", snap.hiddenMs)
    }

    private fun body(currentItemId: Int?, error: Pair<String?, String>? = null): String = buildJsonObject {
        put("currentItemId", currentItemId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("apkVersion", apkVersion)
        put("surface", surface)
        putVisibility()
        if (error != null) putJsonObject("error") {
            error.first?.let { put("sha256", it) }
            put("message", error.second)
        }
    }.toString()

    /**
     * Periodic proof-of-life carrying on-screen state. Deliberately omits
     * currentItemId — the server reads an absent field as "don't touch, don't
     * count", so sampling can never inflate media.play_count.
     */
    fun heartbeat(deviceId: String) = poster.post(
        deviceId,
        buildJsonObject {
            put("apkVersion", apkVersion)
            put("surface", surface)
            putVisibility()
        }.toString()
    )

    fun itemStarted(deviceId: String, currentItemId: Int) = poster.post(deviceId, body(currentItemId))
    fun itemFailed(deviceId: String, currentItemId: Int?, sha256: String?, message: String) =
        poster.post(deviceId, body(currentItemId, sha256 to message))
    fun clearedCurrent(deviceId: String) = poster.post(deviceId, body(null))
}

class OkHttpTelemetryPoster(
    private val http: okhttp3.OkHttpClient,
    private val serverBaseUrl: String
) : TelemetryPoster {
    override fun post(deviceId: String, jsonBody: String) {
        val req = okhttp3.Request.Builder()
            .url("$serverBaseUrl/api/devices/$deviceId/telemetry")
            .post(jsonBody.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {}
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) { response.close() }
        })
    }
}
