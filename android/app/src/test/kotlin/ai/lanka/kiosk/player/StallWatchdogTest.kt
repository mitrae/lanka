package ai.lanka.kiosk.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 1:1 port of tests/player/createStallWatchdog.test.ts — the web and native
 *  stall detectors must agree, or a clip that recovers on one surface freezes
 *  on the other. */
class StallWatchdogTest {

    @Test fun `no stall while position keeps advancing`() {
        val w = StallWatchdog(6000)
        assertFalse(w.observe(nowMs = 0, positionMs = 0, expectPlaying = true))
        for (i in 1..10) assertFalse(w.observe(i * 2000L, i * 2000L, true))
    }

    @Test fun `stall once position is frozen for the threshold`() {
        val w = StallWatchdog(6000)
        assertFalse(w.observe(0, 12_500, true))
        assertFalse(w.observe(2000, 12_500, true))
        assertFalse(w.observe(4000, 12_500, true))
        assertTrue(w.observe(6000, 12_500, true))
    }

    @Test fun `re-arms after firing rather than reporting every tick`() {
        val w = StallWatchdog(6000)
        w.observe(0, 5000, true)
        assertTrue(w.observe(6000, 5000, true))
        assertFalse(w.observe(8000, 5000, true))
        assertTrue(w.observe(12_000, 5000, true))
    }

    @Test fun `never stalls while playback is not expected`() {
        val w = StallWatchdog(6000)
        w.observe(0, 5000, false)
        assertFalse(w.observe(60_000, 5000, false))
    }

    @Test fun `restarts the window when playback resumes`() {
        val w = StallWatchdog(6000)
        w.observe(0, 5000, true)
        w.observe(30_000, 5000, false)
        assertFalse(w.observe(31_000, 5000, true))
        assertFalse(w.observe(36_000, 5000, true))
        assertTrue(w.observe(37_000, 5000, true))
    }

    @Test fun `REPEAT_MODE_ONE wrap (position jumping backwards) is progress`() {
        val w = StallWatchdog(6000)
        w.observe(0, 604_900, true)
        assertFalse(w.observe(2000, 200, true))
        assertFalse(w.observe(7000, 200, true))
        assertTrue(w.observe(8001, 200, true))
    }

    @Test fun `sub-millisecond jitter is not progress`() {
        val w = StallWatchdog(6000)
        w.observe(0, 5000, true)
        assertFalse(w.observe(3000, 5000, true))
        assertTrue(w.observe(6000, 5000, true))
    }

    @Test fun `uses the long startup threshold until playback has begun`() {
        val w = StallWatchdog(startupMs = 45_000, playingMs = 8000)
        w.observe(0, 0, true, started = false)
        assertFalse(w.observe(8000, 0, true, started = false))
        assertFalse(w.observe(30_000, 0, true, started = false))
        assertTrue(w.observe(45_000, 0, true, started = false))
    }

    @Test fun `switches to the short threshold once playback has begun`() {
        val w = StallWatchdog(startupMs = 45_000, playingMs = 8000)
        w.observe(0, 12_000, true, started = true)
        assertFalse(w.observe(7000, 12_000, true, started = true))
        assertTrue(w.observe(8000, 12_000, true, started = true))
    }

    @Test fun `reset clears the window`() {
        val w = StallWatchdog(6000)
        w.observe(0, 5000, true)
        w.reset()
        assertFalse(w.observe(6000, 5000, true))
        assertTrue(w.observe(12_000, 5000, true))
    }
}
