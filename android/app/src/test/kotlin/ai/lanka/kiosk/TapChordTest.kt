package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test

class TapChordTest {

    private class FakeClock(var nowMs: Long = 0L) { fun get(): Long = nowMs }

    @Test
    fun `fires on the nth tap inside the window and resets`() {
        val clock = FakeClock()
        val chord = TapChord(taps = 5, windowMs = 2_000, now = clock::get)
        repeat(4) { clock.nowMs += 200; assertFalse(chord.tap()) }
        clock.nowMs += 200
        assertTrue(chord.tap())
        // counter reset: the next tap starts over
        clock.nowMs += 200
        assertFalse(chord.tap())
    }

    @Test
    fun `taps outside the window are forgotten`() {
        val clock = FakeClock()
        val chord = TapChord(taps = 5, windowMs = 2_000, now = clock::get)
        repeat(4) { clock.nowMs += 100; chord.tap() }
        clock.nowMs += 2_500 // everything above is now stale
        assertFalse(chord.tap())
        repeat(3) { clock.nowMs += 100; assertFalse(chord.tap()) }
        clock.nowMs += 100
        assertTrue(chord.tap()) // 5 fresh taps within 2 s
    }

    @Test
    fun `one short of n never fires`() {
        val clock = FakeClock()
        val chord = TapChord(taps = 5, windowMs = 2_000, now = clock::get)
        repeat(4) { clock.nowMs += 100; assertFalse(chord.tap()) }
    }
}
