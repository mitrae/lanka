package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test

class KioskVisibilityTest {

    private class FakeClock(var nowMs: Long = 0L) { fun get(): Long = nowMs }

    /** A visibility that has been brought fully to the foreground, as at boot. */
    private fun live(c: FakeClock): KioskVisibility =
        KioskVisibility(c::get).apply {
            onStarted(); onResumed(); onFocusChanged(true)
        }

    @Test
    fun `starts background so a background launch never claims the screen`() {
        val c = FakeClock()
        assertEquals(KioskVisibility.State.BACKGROUND, KioskVisibility(c::get).snapshot().state)
    }

    @Test
    fun `reaching the foreground is not debounced`() {
        val c = FakeClock()
        assertEquals(KioskVisibility.State.FOREGROUND, live(c).snapshot().state)
    }

    @Test
    fun `focus loss becomes obscured after the debounce`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        c.nowMs = 1_999
        assertEquals(KioskVisibility.State.FOREGROUND, v.snapshot().state)
        c.nowMs = 2_000
        assertEquals(KioskVisibility.State.OBSCURED, v.snapshot().state)
    }

    @Test
    fun `pause without stop becomes obscured — a translucent overlay`() {
        val c = FakeClock()
        val v = live(c)
        v.onPaused()
        c.nowMs = 2_000
        assertEquals(KioskVisibility.State.OBSCURED, v.snapshot().state)
    }

    @Test
    fun `stop becomes background`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 2_000
        assertEquals(KioskVisibility.State.BACKGROUND, v.snapshot().state)
    }

    @Test
    fun `an obscured to background move does not restart the debounce`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        c.nowMs = 1_900
        v.onPaused()
        v.onStopped()
        c.nowMs = 2_000
        // The episode began at 0, so 2000ms of CONTINUOUS hiding qualifies even
        // though the sub-state changed 100ms ago.
        assertEquals(KioskVisibility.State.BACKGROUND, v.snapshot().state)
    }

    @Test
    fun `a snap-back sized excursion never surfaces but is still counted`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        v.onSnapBackScheduled()
        c.nowMs = 400
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        c.nowMs = 500
        val s = v.snapshot()
        assertEquals(KioskVisibility.State.FOREGROUND, s.state)
        assertEquals(1, s.snapBacks)
        assertEquals(400L, s.hiddenMs)
    }

    @Test
    fun `recovery to foreground is not debounced`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 5_000
        assertEquals(KioskVisibility.State.BACKGROUND, v.snapshot().state)
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        assertEquals(KioskVisibility.State.FOREGROUND, v.snapshot().state)
    }

    @Test
    fun `hiddenMs accumulates across obscured and background`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        c.nowMs = 1_000
        v.onStopped()
        c.nowMs = 3_000
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        c.nowMs = 9_000
        assertEquals(3_000L, v.snapshot().hiddenMs)
    }

    @Test
    fun `a backwards clock never decreases hiddenMs`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 5_000
        val before = v.snapshot().hiddenMs
        c.nowMs = 1_000 // NTP correction, routine shortly after boot
        assertEquals(before, v.snapshot().hiddenMs)
    }

    @Test
    fun `episodeMs reports the length of the current hidden stretch only`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 4_000
        assertEquals(4_000L, v.snapshot().episodeMs)
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        assertEquals(0L, v.snapshot().episodeMs)
    }

    @Test
    fun `focus losses are counted but regains are not`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        v.onFocusChanged(true)
        v.onFocusChanged(false)
        assertEquals(2, v.snapshot().focusLosses)
    }

    @Test
    fun `changeSeq moves only on a reportable change`() {
        val c = FakeClock()
        val v = live(c)
        val seq0 = v.snapshot().changeSeq
        assertEquals(seq0, v.snapshot().changeSeq)      // idle sampling: no move
        v.onStopped()
        c.nowMs = 1_000
        assertEquals(seq0, v.snapshot().changeSeq)      // still debouncing
        c.nowMs = 2_000
        assertNotEquals(seq0, v.snapshot().changeSeq)   // now reportable
    }

    @Test
    fun `shouldPost fires on a change or once per heartbeat`() {
        assertTrue(KioskVisibility.shouldPost(2, 1, 0))
        assertFalse(KioskVisibility.shouldPost(1, 1, 29_999))
        assertTrue(KioskVisibility.shouldPost(1, 1, 30_000))
    }

    @Test
    fun `toJson emits the bridge contract without a package`() {
        val s = KioskVisibility.Snapshot(
            KioskVisibility.State.BACKGROUND, 3, 2, 1_500, 800, 7
        )
        assertEquals(
            """{"visibility":"background","snapBacks":3,"focusLosses":2,""" +
                """"hiddenMs":1500,"episodeMs":800,"changeSeq":7}""",
            s.toJson()
        )
    }
}
