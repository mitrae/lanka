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
        assertTrue(s is InterruptState.Active)
        assertEquals(0L, (s as InterruptState.Active).offsetMs)
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
        t.markDone()
        assertTrue(!isActive(t.observe(start + 30_000)))
        assertTrue(!isActive(t.observe(start + 1_000)))
    }

    @Test fun `clears the latch on a new window`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone()
        val tomorrow = sched.copy(startsAt = start + 86_400_000, endsAt = start + 86_400_000 + 60_000)
        t.setSchedule(tomorrow, start + 86_400_000, start + 86_400_000)
        assertTrue(isActive(t.observe(start + 86_400_000)))
    }

    @Test fun `keeps the latch when the same window is republished`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone()
        t.setSchedule(sched, start + 5_000, start + 5_000)
        assertTrue(!isActive(t.observe(start + 5_000)))
    }

    @Test fun `keeps the latch across a withdrawal and republish`() {
        val t = InterruptTimer()
        t.setSchedule(sched, start, start)
        t.markDone()
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
