package ai.lanka.kiosk.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InterruptTimerTest {
    private val start = 1_800_000_000_000L
    private val sched = ManifestInterrupt(9, "silence", 60_000, start, start + 60_000)

    private fun isActive(s: InterruptState) = s is InterruptState.Active

    @Test fun `inactive with no schedule`() {
        assertTrue(!isActive(InterruptTimer().observe(start)))
    }

    @Test fun `inactive before the window`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start - 10_000, start - 10_000)
        assertTrue(!isActive(t.observe(start - 1)))
    }

    @Test fun `activates at startsAt with zero offset`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start - 10_000, start - 10_000)
        val s = t.observe(start)
        assertEquals(InterruptState.Active(sched, 0L), s)
    }

    @Test fun `joins in progress with the elapsed offset`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start + 35_000, start + 35_000)
        val s = t.observe(start + 35_000) as InterruptState.Active
        assertEquals(35_000L, s.offsetMs)
    }

    @Test fun `goes inactive at endsAt`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        assertTrue(isActive(t.observe(start + 59_999)))
        assertTrue(!isActive(t.observe(start + 60_000)))
    }

    @Test fun `corrects a wrong client clock from serverNow`() {
        val t = InterruptTimer()
        val clientNow = start - 3_600_000 - 10_000
        t.setSchedule(sched, start - 10_000, clientNow)
        assertTrue(!isActive(t.observe(clientNow)))
        assertTrue(isActive(t.observe(clientNow + 10_000)))
    }

    @Test fun `refuses when the join offset exceeds the clip duration`() {
        val t = InterruptTimer()
        t.setSchedule(sched.copy(durationMs = 10_000), start + 20_000, start + 20_000)
        assertTrue(!isActive(t.observe(start + 20_000)))
    }

    @Test fun `does not replay a window already done`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start + 30_000, start + 30_000)
        assertTrue(isActive(t.observe(start + 30_000)))
        t.markDone(start)
        assertTrue(!isActive(t.observe(start + 30_000)))
        assertTrue(!isActive(t.observe(start + 1_000)))
    }

    @Test fun `clears the latch on a new window`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone(start)
        val tomorrow = sched.copy(startsAt = start + 86_400_000, endsAt = start + 86_400_000 + 60_000)
        t.setSchedule(tomorrow, start + 86_400_000, start + 86_400_000)
        assertTrue(isActive(t.observe(start + 86_400_000)))
    }

    @Test fun `keeps the latch when the same window is republished`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone(start)
        t.setSchedule(sched, start + 5_000, start + 5_000)
        assertTrue(!isActive(t.observe(start + 5_000)))
    }

    @Test fun `keeps the latch across a withdrawal and republish`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone(start)
        t.setSchedule(null, null, start + 5_000)
        t.setSchedule(sched, start + 10_000, start + 10_000)
        assertTrue(!isActive(t.observe(start + 10_000)))
    }

    @Test fun `stops at endsAt even when the clip is longer than the window`() {
        val t = InterruptTimer()
        t.setSchedule(sched.copy(durationMs = 600_000), start, start)
        assertTrue(isActive(t.observe(start + 59_999)))
        assertTrue(!isActive(t.observe(start + 60_000)))
    }

    @Test fun `latches the window that played not a newer schedule that arrived first`() {
        // The server rolls nextWindow over to tomorrow at exactly endsAt and the
        // tick observes up to 500 ms later, so a poll landing in that gap loads
        // TOMORROW's window while today's teardown is still pending. Latching the
        // loaded schedule there would silently skip tomorrow.
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        assertTrue(isActive(t.observe(start + 30_000)))
        val tomorrow = sched.copy(startsAt = start + 86_400_000, endsAt = start + 86_400_000 + 60_000)
        t.setSchedule(tomorrow, start + 60_000, start + 60_000)
        t.markDone(start)
        assertTrue(isActive(t.observe(start + 86_400_000)))
    }

    @Test fun `a withdrawal during the window still latches the window that played`() {
        // `enabled` toggled off mid-window leaves no schedule loaded at teardown;
        // with nothing to latch, the republish that follows would replay it.
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        assertTrue(isActive(t.observe(start + 10_000)))
        t.setSchedule(null, null, start + 20_000)
        t.markDone(start)
        t.setSchedule(sched, start + 30_000, start + 30_000)
        assertTrue(!isActive(t.observe(start + 30_000)))
    }

    @Test fun `stays active when a later clock sample moves the corrected clock back before startsAt`() {
        // A 30 s poll that left at 08:59:58 and took 3 s to answer derives an
        // offset 3 s behind the previous one. Reading that as Inactive ended
        // the clip 1.5 s in and latched the day as done.
        val t = InterruptTimer()
        t.setSchedule(sched, start - 10_000, start - 10_000)
        assertTrue(isActive(t.observe(start + 1_500)))
        t.setSchedule(sched, start - 1_500, start + 1_500) // offset becomes -3 s
        val s = t.observe(start + 1_600)
        assertEquals(InterruptState.Active(sched, 0L), s) // clamped, never negative
        assertTrue(!isActive(t.observe(start + 60_000 + 3_000))) // still ends on endsAt
    }

    @Test fun `a backwards correction before the window ever became active still means inactive`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start - 5_000) // TV 5 s behind: offset +5 s
        assertTrue(!isActive(t.observe(start - 1_000 - 5_000)))
        t.setSchedule(sched, start - 4_000, start - 5_000) // offset +1 s
        assertTrue(!isActive(t.observe(start - 3_000)))
    }

    @Test fun `correctedNow applies the derived offset to a client instant`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start - 3_600_000) // TV an hour behind
        assertEquals(start + 5_000, t.correctedNow(start - 3_600_000 + 5_000))
    }

    @Test fun `keeps a previously derived offset when serverNow is null`() {
        val t = InterruptTimer()
        val clientNow = start - 3_600_000
        t.setSchedule(sched, start, clientNow)
        t.setSchedule(sched, null, clientNow)
        assertTrue(isActive(t.observe(clientNow)))
    }

    @Test fun `goes inactive when the schedule is withdrawn`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        assertTrue(isActive(t.observe(start)))
        t.setSchedule(null, null, start)
        assertTrue(!isActive(t.observe(start)))
    }
}
