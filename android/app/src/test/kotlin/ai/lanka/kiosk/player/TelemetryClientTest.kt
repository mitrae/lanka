package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class CapturingPoster : TelemetryPoster {
    val bodies = mutableListOf<Pair<String, String>>()
    override fun post(deviceId: String, jsonBody: String) { bodies.add(deviceId to jsonBody) }
}

class TelemetryClientTest {
    @Test fun `itemStarted posts currentItemId + surface + apkVersion`() {
        val p = CapturingPoster(); TelemetryClient(p, "1.0.0").itemStarted("dev", 42)
        val (dev, body) = p.bodies.single()
        assertEquals("dev", dev)
        assertTrue(body.contains("\"currentItemId\":42"))
        assertTrue(body.contains("\"surface\":\"native\""))
        assertTrue(body.contains("\"apkVersion\":\"1.0.0\""))
        assertTrue(!body.contains("error"))
    }
    @Test fun `itemFailed includes error object`() {
        val p = CapturingPoster(); TelemetryClient(p, "1.0.0").itemFailed("dev", 7, "sha-7", "decode")
        val body = p.bodies.single().second
        assertTrue(body.contains("\"currentItemId\":7"))
        assertTrue(body.contains("\"message\":\"decode\""))
        assertTrue(body.contains("\"sha256\":\"sha-7\""))
    }
    @Test fun `clearedCurrent posts null currentItemId`() {
        val p = CapturingPoster(); TelemetryClient(p, "1.0.0").clearedCurrent("dev")
        assertTrue(p.bodies.single().second.contains("\"currentItemId\":null"))
    }
}
