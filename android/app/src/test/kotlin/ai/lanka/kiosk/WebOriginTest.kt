package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test

class WebOriginTest {

    @Test
    fun `originOf normalizes scheme host and explicit port, dropping path and query`() {
        assertEquals(
            "http://lanka-server:3000",
            WebOrigin.originOf("http://lanka-server:3000/player?deviceId=abc")
        )
    }

    @Test
    fun `originOf fills the default port per scheme`() {
        assertEquals("http://evil.com:80", WebOrigin.originOf("http://evil.com/x"))
        assertEquals("https://evil.com:443", WebOrigin.originOf("https://evil.com/x"))
    }

    @Test
    fun `originOf lowercases scheme and host`() {
        assertEquals("http://lanka-server:3000", WebOrigin.originOf("HTTP://Lanka-Server:3000/"))
    }

    @Test
    fun `originOf returns null for blank or opaque urls`() {
        assertNull(WebOrigin.originOf(null))
        assertNull(WebOrigin.originOf(""))
        assertNull(WebOrigin.originOf("about:blank"))
        assertNull(WebOrigin.originOf("javascript:alert(1)"))
    }

    @Test
    fun `sameOrigin true for same scheme host port regardless of path`() {
        assertTrue(
            WebOrigin.sameOrigin(
                "http://lanka-server:3000/player?deviceId=a",
                "http://lanka-server:3000"
            )
        )
    }

    @Test
    fun `sameOrigin false across differing host, port, or scheme`() {
        val trusted = "http://lanka-server:3000"
        assertFalse(WebOrigin.sameOrigin("http://evil.com:3000/", trusted))
        assertFalse(WebOrigin.sameOrigin("http://lanka-server:3001/", trusted))
        assertFalse(WebOrigin.sameOrigin("https://lanka-server:3000/", trusted))
    }

    @Test
    fun `sameOrigin false when either url is null or unparseable`() {
        val trusted = "http://lanka-server:3000"
        assertFalse(WebOrigin.sameOrigin(null, trusted))
        assertFalse(WebOrigin.sameOrigin(trusted, null))
        assertFalse(WebOrigin.sameOrigin("about:blank", trusted))
    }
}
