package ai.lanka.kiosk.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrefetchGateTest {
    private val t0 = 1_000_000L

    @Test fun `first attempt for a sha is allowed`() {
        assertTrue(PrefetchGate().shouldTry("a", t0))
    }

    @Test fun `after a failure the next attempt waits a full minute, then doubles`() {
        val g = PrefetchGate()
        g.failed("a", t0)
        assertFalse(g.shouldTry("a", t0 + 59_000))
        assertTrue(g.shouldTry("a", t0 + 60_000))
        g.failed("a", t0 + 60_000)
        assertFalse(g.shouldTry("a", t0 + 60_000 + 119_000))
        assertTrue(g.shouldTry("a", t0 + 60_000 + 120_000))
    }

    @Test fun `the delay is capped at an hour`() {
        val g = PrefetchGate()
        var now = t0
        repeat(12) { g.failed("a", now); now += 3_600_000L }
        g.failed("a", now)
        assertFalse(g.shouldTry("a", now + 3_599_000))
        assertTrue(g.shouldTry("a", now + 3_600_000))
    }

    @Test fun `a new sha gets a fresh budget`() {
        val g = PrefetchGate()
        g.failed("a", t0)
        assertTrue(g.shouldTry("b", t0))
    }

    @Test fun `success clears the backoff`() {
        val g = PrefetchGate()
        g.failed("a", t0)
        g.succeeded("a")
        assertTrue(g.shouldTry("a", t0))
    }
}
