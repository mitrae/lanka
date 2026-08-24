package ai.lanka.kiosk.player

import ai.lanka.kiosk.KioskVisibility
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

    private fun vis(
        state: KioskVisibility.State = KioskVisibility.State.BACKGROUND,
        pkg: String? = "com.netflix.ninja"
    ): () -> Pair<KioskVisibility.Snapshot, String?> = {
        KioskVisibility.Snapshot(state, 5, 2, 900, 900, 3) to pkg
    }

    @Test fun `heartbeat carries visibility and omits currentItemId`() {
        val p = CapturingPoster()
        TelemetryClient(p, "1.0.0", visibility = vis()).heartbeat("dev")
        val body = p.bodies.single().second
        assertTrue("a heartbeat must not send currentItemId", !body.contains("currentItemId"))
        assertTrue(body.contains("\"visibility\":\"background\""))
        assertTrue(body.contains("\"foregroundPackage\":\"com.netflix.ninja\""))
        assertTrue(body.contains("\"snapBacks\":5"))
        assertTrue(body.contains("\"focusLosses\":2"))
        assertTrue(body.contains("\"hiddenMs\":900"))
        assertTrue(body.contains("\"surface\":\"native\""))
    }

    @Test fun `every event post carries visibility too`() {
        val p = CapturingPoster()
        val t = TelemetryClient(p, "1.0.0", visibility = vis())
        t.itemStarted("dev", 42)
        t.itemFailed("dev", 42, "sha", "decode")
        t.clearedCurrent("dev")
        assertEquals(3, p.bodies.size)
        p.bodies.forEach { assertTrue(it.second.contains("\"visibility\":\"background\"")) }
        assertTrue(p.bodies[0].second.contains("\"currentItemId\":42"))
    }

    @Test fun `a null package is emitted as JSON null`() {
        val p = CapturingPoster()
        TelemetryClient(p, "1.0.0", visibility = vis(KioskVisibility.State.FOREGROUND, null))
            .heartbeat("dev")
        assertTrue(p.bodies.single().second.contains("\"foregroundPackage\":null"))
    }

    @Test fun `without a visibility supplier the body is unchanged`() {
        val p = CapturingPoster()
        TelemetryClient(p, "1.0.0").itemStarted("dev", 42)
        val body = p.bodies.single().second
        assertTrue(!body.contains("visibility"))
        assertTrue(body.contains("\"currentItemId\":42"))
    }
}
