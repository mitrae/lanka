package ai.lanka.kiosk.player

enum class SchedulerMode { LOOP, SINGLE_VIDEO, SINGLE_IMAGE, EMPTY }

data class TransitionEvent(val from: Int, val to: Int, val nextPreload: Int)

interface SchedulerDeps {
    fun setTimeout(cb: () -> Unit, ms: Long): Any
    fun clearTimeout(handle: Any)
    /** Virtualised in tests; SystemClock.uptimeMillis() in production. */
    fun now(): Long
}

class Scheduler(private val items: List<ManifestItem>, private val deps: SchedulerDeps) {

    val mode: SchedulerMode = when {
        items.isEmpty() -> SchedulerMode.EMPTY
        items.size == 1 -> if (items[0].type == "video") SchedulerMode.SINGLE_VIDEO else SchedulerMode.SINGLE_IMAGE
        else -> SchedulerMode.LOOP
    }

    private var front = 0
    private var back = if (items.size > 1) 1 % items.size else 0
    private var stopped = false
    private var imageTimer: Any? = null
    private var imageTimerIndex = -1
    private var imageTimerArmedAt = 0L
    private var imageTimerMs = 0L
    private var paused = false
    private var pausedRemainingMs: Long? = null
    /** start() arrived while paused — a manifest mounted DURING an interrupt
     *  window. The first item start (telemetry + slide timer) is owed to
     *  resume(): emitting it under the overlay would count a play nobody saw
     *  and run the slide clock behind the clip. See the TS twin. */
    private var startDeferred = false

    private val itemStartHandlers = mutableSetOf<(Int) -> Unit>()
    private val transitionHandlers = mutableSetOf<(TransitionEvent) -> Unit>()
    private val errorHandlers = mutableSetOf<(Int, String) -> Unit>()

    private fun emitItemStart(i: Int) = itemStartHandlers.toList().forEach { it(i) }
    private fun emitTransition(e: TransitionEvent) = transitionHandlers.toList().forEach { it(e) }
    private fun emitError(i: Int, msg: String) = errorHandlers.toList().forEach { it(i, msg) }

    private fun nowMs() = deps.now()

    private fun clearImageTimer() { imageTimer?.let { deps.clearTimeout(it) }; imageTimer = null }

    private fun armImageTimerIfNeeded(index: Int) {
        val item = items.getOrNull(index) ?: return
        if (item.type != "image") return
        armImageTimer(index, maxOf(0, item.durationMs).toLong())
    }

    private fun armImageTimer(index: Int, ms: Long) {
        clearImageTimer() // never overwrite a live handle — that leaks it
        imageTimerIndex = index
        imageTimerArmedAt = nowMs()
        imageTimerMs = ms
        imageTimer = deps.setTimeout({
            imageTimer = null
            if (stopped) return@setTimeout
            if (mode == SchedulerMode.SINGLE_IMAGE) { emitItemStart(0); armImageTimerIfNeeded(0); return@setTimeout }
            advance()
        }, ms)
    }

    private fun advance() {
        if (stopped || mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO) return
        if (mode == SchedulerMode.SINGLE_IMAGE) return
        clearImageTimer()
        val from = front; val to = back
        front = to; back = (to + 1) % items.size
        emitTransition(TransitionEvent(from, to, back))
        emitItemStart(front)
        armImageTimerIfNeeded(front)
    }

    fun start() {
        if (stopped || mode == SchedulerMode.EMPTY) return
        if (paused) { startDeferred = true; return }
        emitItemStart(0); armImageTimerIfNeeded(0)
    }

    fun itemEnded(index: Int) {
        // Dropped while paused — see the TS twin.
        if (stopped || paused) return
        if (mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    /** Report a failure WITHOUT letting it drive playback: an error in the
     *  hidden preload slot, or the consecutive error that trips the stalled
     *  state. Emit-only sibling of [itemErrored]; mirrors the web scheduler. */
    fun noteError(index: Int, message: String) {
        if (stopped) return
        emitError(index, message)
    }

    /** Whether [itemErrored] moves playback on to another item. Only a
     *  multi-item loop can; in every single-item mode the view must retry the
     *  player itself, or a broken frame stays on screen forever. */
    val advancesOnError: Boolean get() = mode == SchedulerMode.LOOP

    fun itemErrored(index: Int, message: String) {
        if (stopped) return
        emitError(index, message)
        if (paused) return // report, never advance
        if (mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    fun stop() {
        stopped = true; paused = false; pausedRemainingMs = null; startDeferred = false; clearImageTimer()
        itemStartHandlers.clear(); transitionHandlers.clear(); errorHandlers.clear()
    }

    /**
     * Freeze the playlist for a scheduled interrupt: cancel the slide timer,
     * remembering how much of it was left. While paused the scheduler refuses
     * to advance. Idempotent.
     */
    fun pause() {
        if (stopped || paused) return
        paused = true
        if (imageTimer == null) { pausedRemainingMs = null; return }
        val elapsed = nowMs() - imageTimerArmedAt
        pausedRemainingMs = maxOf(0L, imageTimerMs - elapsed)
        clearImageTimer()
    }

    /** Re-arm the slide timer with its REMAINING time. Idempotent. */
    /**
     * Un-freeze the playlist. Default re-arms the slide timer with its
     * REMAINING time (frame-exact continuation); with [restart] the current
     * item starts over, so an image gets its FULL duration back and the view
     * does the matching seek for a video. Mirrors the TS twin. Idempotent.
     */
    fun resume(restart: Boolean = false) {
        if (stopped || !paused) return
        paused = false
        if (startDeferred) { startDeferred = false; emitItemStart(0); armImageTimerIfNeeded(0); return }
        val remaining = pausedRemainingMs ?: return
        pausedRemainingMs = null
        val full = maxOf(0, items.getOrNull(imageTimerIndex)?.durationMs ?: 0).toLong()
        armImageTimer(imageTimerIndex, if (restart) full else remaining)
    }

    fun getFrontIndex() = front
    fun getBackIndex() = back

    fun onTransition(fn: (TransitionEvent) -> Unit): () -> Unit { transitionHandlers.add(fn); return { transitionHandlers.remove(fn) } }
    fun onItemStart(fn: (Int) -> Unit): () -> Unit { itemStartHandlers.add(fn); return { itemStartHandlers.remove(fn) } }
    fun onItemError(fn: (Int, String) -> Unit): () -> Unit { errorHandlers.add(fn); return { errorHandlers.remove(fn) } }
}
