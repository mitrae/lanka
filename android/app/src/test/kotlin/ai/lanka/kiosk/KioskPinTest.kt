package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class KioskPinTest {

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }

    private class FakeClock(var nowMs: Long = 0L) { fun get(): Long = nowMs }

    private fun pin(value: String = "4931", clock: FakeClock = FakeClock()) =
        KioskPin(sha256(value), value.length, clock::get)

    private fun type(p: KioskPin, digits: String): KioskPin.Result {
        var last = KioskPin.Result.INCOMPLETE
        for (c in digits) last = p.append(c)
        return last
    }

    @Test
    fun `correct pin unlocks`() {
        assertEquals(KioskPin.Result.UNLOCKED, type(pin(), "4931"))
    }

    @Test
    fun `partial entry is incomplete`() {
        val p = pin()
        assertEquals(KioskPin.Result.INCOMPLETE, type(p, "493"))
        assertEquals(3, p.entryLength)
    }

    @Test
    fun `wrong pin reports wrong and clears entry`() {
        val p = pin()
        assertEquals(KioskPin.Result.WRONG, type(p, "0000"))
        assertEquals(0, p.entryLength)
    }

    @Test
    fun `lockout engages on fifth consecutive failure`() {
        val p = pin()
        repeat(4) { assertEquals(KioskPin.Result.WRONG, type(p, "0000")) }
        assertFalse(p.isLockedOut())
        assertEquals(KioskPin.Result.WRONG, type(p, "0000"))
        assertTrue(p.isLockedOut())
    }

    @Test
    fun `input during lockout is rejected without extending it`() {
        val clock = FakeClock()
        val p = pin(clock = clock)
        repeat(5) { type(p, "0000") }
        clock.nowMs = 30_000
        assertEquals(KioskPin.Result.LOCKED_OUT, p.append('4'))
        assertEquals(30_000L, p.lockedOutMsRemaining())
    }

    @Test
    fun `lockout expires on the injected clock`() {
        val clock = FakeClock()
        val p = pin(clock = clock)
        repeat(5) { type(p, "0000") }
        clock.nowMs = 60_000
        assertFalse(p.isLockedOut())
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
    }

    @Test
    fun `success resets the failure counter`() {
        val p = pin()
        repeat(4) { type(p, "0000") }
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
        repeat(4) { assertEquals(KioskPin.Result.WRONG, type(p, "0000")) }
        assertFalse(p.isLockedOut())
    }

    @Test
    fun `reset clears entry but keeps failure state`() {
        val p = pin()
        repeat(4) { type(p, "0000") }
        type(p, "49")
        p.reset()
        assertEquals(0, p.entryLength)
        // 4 failures survived reset → this 5th one locks out
        assertEquals(KioskPin.Result.WRONG, type(p, "0000"))
        assertTrue(p.isLockedOut())
    }

    @Test
    fun `non-digit characters are ignored`() {
        val p = pin()
        assertEquals(KioskPin.Result.INCOMPLETE, p.append('x'))
        assertEquals(0, p.entryLength)
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
    }

    @Test
    fun `empty expected hash disables the feature`() {
        val p = KioskPin("", 0) { 0L }
        assertFalse(p.enabled)
        assertEquals(KioskPin.Result.WRONG, p.append('4'))
    }

    @Test
    fun `hash comparison is case insensitive`() {
        val p = KioskPin(sha256("4931").uppercase(), 4) { 0L }
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
    }
}
