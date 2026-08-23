package ai.lanka.kiosk.player

import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

interface TelemetryPoster { fun post(deviceId: String, jsonBody: String) }

class TelemetryClient(
    private val poster: TelemetryPoster,
    private val apkVersion: String,
    private val surface: String = "native"
) {
    private fun body(currentItemId: Int?, error: Pair<String?, String>? = null): String = buildJsonObject {
        put("currentItemId", currentItemId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("apkVersion", apkVersion)
        put("surface", surface)
        if (error != null) putJsonObject("error") {
            error.first?.let { put("sha256", it) }
            put("message", error.second)
        }
    }.toString()

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
