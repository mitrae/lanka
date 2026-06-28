package ai.lanka.kiosk.player

enum class SchedulerMode { LOOP, SINGLE_VIDEO, SINGLE_IMAGE, EMPTY }

data class TransitionEvent(val from: Int, val to: Int, val nextPreload: Int)

interface SchedulerDeps {
    fun setTimeout(cb: () -> Unit, ms: Long): Any
    fun clearTimeout(handle: Any)
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

    private val itemStartHandlers = mutableSetOf<(Int) -> Unit>()
    private val transitionHandlers = mutableSetOf<(TransitionEvent) -> Unit>()
    private val errorHandlers = mutableSetOf<(Int, String) -> Unit>()

    private fun emitItemStart(i: Int) = itemStartHandlers.toList().forEach { it(i) }
    private fun emitTransition(e: TransitionEvent) = transitionHandlers.toList().forEach { it(e) }
    private fun emitError(i: Int, msg: String) = errorHandlers.toList().forEach { it(i, msg) }

    private fun clearImageTimer() { imageTimer?.let { deps.clearTimeout(it) }; imageTimer = null }

    private fun armImageTimerIfNeeded(index: Int) {
        val item = items.getOrNull(index) ?: return
        if (item.type != "image") return
        val durationMs = maxOf(0, item.durationMs).toLong()
        imageTimer = deps.setTimeout({
            imageTimer = null
            if (stopped) return@setTimeout
            if (mode == SchedulerMode.SINGLE_IMAGE) { emitItemStart(0); armImageTimerIfNeeded(0); return@setTimeout }
            advance()
        }, durationMs)
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
        emitItemStart(0); armImageTimerIfNeeded(0)
    }

    fun itemEnded(index: Int) {
        if (stopped || mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    fun itemErrored(index: Int, message: String) {
        if (stopped) return
        emitError(index, message)
        if (mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    fun stop() {
        stopped = true; clearImageTimer()
        itemStartHandlers.clear(); transitionHandlers.clear(); errorHandlers.clear()
    }

    fun getFrontIndex() = front
    fun getBackIndex() = back

    fun onTransition(fn: (TransitionEvent) -> Unit): () -> Unit { transitionHandlers.add(fn); return { transitionHandlers.remove(fn) } }
    fun onItemStart(fn: (Int) -> Unit): () -> Unit { itemStartHandlers.add(fn); return { itemStartHandlers.remove(fn) } }
    fun onItemError(fn: (Int, String) -> Unit): () -> Unit { errorHandlers.add(fn); return { errorHandlers.remove(fn) } }
}
