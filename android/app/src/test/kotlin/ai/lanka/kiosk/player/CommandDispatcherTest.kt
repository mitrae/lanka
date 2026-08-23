package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeActions : CommandActions {
    var rebooted = false; var locked: Boolean? = null; var ota: Triple<String, String, Int>? = null; var reloaded = false
    var surfaceRequested: String? = null; var surfaceReason: String? = null
    override fun reboot(): Boolean { rebooted = true; return true }
    override fun screenshot() = "data:image/png;base64,AAAA"
    override fun getLogs() = "log-line-1"
    override fun setKioskLock(enabled: Boolean) { locked = enabled }
    override fun installOta(sha256: String, url: String, commandId: Int): Boolean { ota = Triple(sha256, url, commandId); return true }
    override fun reload() { reloaded = true }
    override fun setSurface(name: String): String? { surfaceRequested = name; return surfaceReason }
}
private class FakeSender : AckSender { val sent = mutableListOf<String>(); override fun send(json: String) { sent.add(json) } }

class CommandDispatcherTest {
    @Test fun `screenshot acks with result`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":1,"cmd":"screenshot","payload":null}""")
        assertTrue(s.sent.single().contains("\"commandId\":1"))
        assertTrue(s.sent.single().contains("\"status\":\"acked\""))
        assertTrue(s.sent.single().contains("data:image/png"))
    }
    @Test fun `kiosk-lock toggles and acks`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":2,"cmd":"kiosk-lock","payload":null}""")
        assertEquals(true, a.locked); assertTrue(s.sent.single().contains("\"status\":\"acked\""))
    }
    @Test fun `log-request acks with logs`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":3,"cmd":"log-request","payload":null}""")
        assertTrue(s.sent.single().contains("log-line-1"))
    }
    @Test fun `reboot reboots and sends no ack`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":4,"cmd":"reboot","payload":null}""")
        assertTrue(a.rebooted); assertTrue(s.sent.isEmpty())
    }
    @Test fun `ota with missing payload fails`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":5,"cmd":"ota","payload":{}}""")
        assertTrue(s.sent.single().contains("\"status\":\"failed\""))
    }
    @Test fun `ota installs with sha + url`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":6,"cmd":"ota","payload":{"sha256":"abc","url":"http://h/x.apk"}}""")
        assertEquals(Triple("abc", "http://h/x.apk", 6), a.ota)
        assertTrue(s.sent.isEmpty())
    }
    @Test fun `kiosk-unlock toggles and acks`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":7,"cmd":"kiosk-unlock","payload":null}""")
        assertEquals(false, a.locked); assertTrue(s.sent.single().contains("\"status\":\"acked\""))
    }
    @Test fun `malformed json is ignored`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s).handle("not json")
        assertTrue(s.sent.isEmpty())
    }
    @Test fun `set-surface acks when the action accepts`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":8,"cmd":"set-surface","payload":{"surface":"native"}}""")
        assertEquals("native", a.surfaceRequested)
        assertTrue(s.sent.single().contains("\"commandId\":8"))
        assertTrue(s.sent.single().contains("\"status\":\"acked\""))
    }
    @Test fun `set-surface fails with the action's reason`() {
        val a = FakeActions().apply { surfaceReason = "ota in progress" }; val s = FakeSender()
        CommandDispatcher(a, s).handle("""{"commandId":9,"cmd":"set-surface","payload":{"surface":"native"}}""")
        assertTrue(s.sent.single().contains("\"status\":\"failed\""))
        assertTrue(s.sent.single().contains("ota in progress"))
    }
    @Test fun `set-surface without a surface fails`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":10,"cmd":"set-surface","payload":{}}""")
        assertEquals(null, a.surfaceRequested)
        assertTrue(s.sent.single().contains("\"status\":\"failed\""))
        assertTrue(s.sent.single().contains("missing surface"))
    }
}
