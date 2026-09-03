package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Test

private class FakeDeps : SchedulerDeps {
    private data class P(val cb: () -> Unit, val at: Long, val id: Int)
    private var now = 0L; private var nextId = 1; private val pending = mutableListOf<P>()
    override fun setTimeout(cb: () -> Unit, ms: Long): Any { val id = nextId++; pending.add(P(cb, now + ms, id)); return id }
    override fun clearTimeout(handle: Any) { pending.removeAll { it.id == handle } }
    fun pending() = pending.size
    fun advanceTime(ms: Long) {
        now += ms
        while (true) {
            val due = pending.firstOrNull { it.at <= now } ?: break
            pending.remove(due); due.cb()
        }
    }
}
private fun video(id: Int, dur: Int = 10_000) = ManifestItem(id, "video", "sha-$id", dur)
private fun image(id: Int, dur: Int = 8_000) = ManifestItem(id, "image", "sha-$id", dur)

class SchedulerTest {
    @Test fun `emits onItemStart(0) on start with multi-item`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), image(3)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(listOf(0), starts); assertEquals(0, s.getFrontIndex()); assertEquals(1, s.getBackIndex())
        assertEquals(SchedulerMode.LOOP, s.mode)
    }

    @Test fun `advances front on itemEnded with transition + start`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val t = mutableListOf<TransitionEvent>(); val starts = mutableListOf<Int>()
        s.onTransition { t.add(it) }; s.onItemStart { starts.add(it) }; s.start()
        s.itemEnded(0)
        assertEquals(listOf(TransitionEvent(0, 1, 2)), t); assertEquals(listOf(0, 1), starts)
        assertEquals(1, s.getFrontIndex()); assertEquals(2, s.getBackIndex())
        s.itemEnded(1); assertEquals(TransitionEvent(1, 2, 0), t[1])
        s.itemEnded(2); assertEquals(TransitionEvent(2, 0, 1), t[2]); assertEquals(0, s.getFrontIndex())
    }

    @Test fun `ignores stale itemEnded`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val t = mutableListOf<TransitionEvent>(); s.onTransition { t.add(it) }; s.start()
        s.itemEnded(0); assertEquals(1, t.size); s.itemEnded(0); assertEquals(1, t.size)
    }

    @Test fun `arms image timer for durationMs`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 5_000), video(2)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(1, deps.pending()); deps.advanceTime(4_999); assertEquals(listOf(0), starts)
        deps.advanceTime(1); assertEquals(listOf(0, 1), starts); assertEquals(1, s.getFrontIndex())
    }

    @Test fun `no timer for video items`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), image(2)), deps); s.start(); assertEquals(0, deps.pending())
    }

    @Test fun `clears image timer on itemEnded`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 5_000), video(2)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start(); assertEquals(1, deps.pending())
        s.itemEnded(0); assertEquals(0, deps.pending()); deps.advanceTime(10_000); assertEquals(listOf(0, 1), starts)
    }

    @Test fun `itemErrored emits error and advances`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val errs = mutableListOf<Pair<Int, String>>(); val t = mutableListOf<TransitionEvent>()
        s.onItemError { i, m -> errs.add(i to m) }; s.onTransition { t.add(it) }; s.start()
        s.itemErrored(0, "decode failed"); assertEquals(listOf(0 to "decode failed"), errs)
        assertEquals(1, t.size); assertEquals(1, s.getFrontIndex())
    }

    @Test fun `noteError only reports and never advances in any mode`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val errs = mutableListOf<Pair<Int, String>>(); val t = mutableListOf<TransitionEvent>()
        s.onItemError { i, m -> errs.add(i to m) }; s.onTransition { t.add(it) }; s.start()
        s.noteError(0, "preload failed")  // index == front: itemErrored would advance here
        assertEquals(listOf(0 to "preload failed"), errs); assertEquals(0, t.size); assertEquals(0, s.getFrontIndex())
    }

    @Test fun `advancesOnError is true only for multi-item loops`() {
        val deps = FakeDeps()
        assertEquals(true, Scheduler(listOf(video(1), video(2)), deps).advancesOnError)
        assertEquals(false, Scheduler(listOf(video(1)), deps).advancesOnError)
        assertEquals(false, Scheduler(listOf(image(1)), deps).advancesOnError)
        assertEquals(false, Scheduler(emptyList(), deps).advancesOnError)
    }

    @Test fun `single video itemErrored reports but never advances`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1)), deps)
        val errs = mutableListOf<Pair<Int, String>>(); val t = mutableListOf<TransitionEvent>()
        s.onItemError { i, m -> errs.add(i to m) }; s.onTransition { t.add(it) }; s.start()
        s.itemErrored(0, "video stalled")
        assertEquals(listOf(0 to "video stalled"), errs); assertEquals(0, t.size); assertEquals(0, s.getFrontIndex())
    }

    @Test fun `single video mode does not advance`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1)), deps)
        val t = mutableListOf<TransitionEvent>(); val starts = mutableListOf<Int>()
        s.onTransition { t.add(it) }; s.onItemStart { starts.add(it) }; s.start()
        assertEquals(SchedulerMode.SINGLE_VIDEO, s.mode); assertEquals(listOf(0), starts)
        s.itemEnded(0); assertEquals(0, t.size); assertEquals(0, s.getFrontIndex())
    }

    @Test fun `single image re-arms timer and re-emits start(0)`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 3_000)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(SchedulerMode.SINGLE_IMAGE, s.mode); assertEquals(listOf(0), starts); assertEquals(1, deps.pending())
        deps.advanceTime(3_000); assertEquals(listOf(0, 0), starts); assertEquals(1, deps.pending())
        deps.advanceTime(3_000); assertEquals(listOf(0, 0, 0), starts)
    }

    @Test fun `stop cancels timer and halts emission`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 5_000)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start(); assertEquals(1, deps.pending())
        s.stop(); assertEquals(0, deps.pending()); deps.advanceTime(10_000); assertEquals(listOf(0), starts)
    }

    @Test fun `empty items is inert`() {
        val deps = FakeDeps(); val s = Scheduler(emptyList(), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(emptyList<Int>(), starts); assertEquals(0, deps.pending()); assertEquals(SchedulerMode.EMPTY, s.mode)
    }

    @Test fun `onItemStart returns unsubscribe`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2)), deps)
        val starts = mutableListOf<Int>(); val unsub = s.onItemStart { starts.add(it) }; s.start(); unsub(); s.itemEnded(0)
        assertEquals(listOf(0), starts)
    }
}
