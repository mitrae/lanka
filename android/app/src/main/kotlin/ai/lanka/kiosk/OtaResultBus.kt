package ai.lanka.kiosk

object OtaResultBus {
    private var listener: ((commandId: Long, status: String) -> Unit)? = null

    fun setListener(fn: (Long, String) -> Unit) { listener = fn }
    fun clearListener() { listener = null }
    fun notify(commandId: Long, status: String) { listener?.invoke(commandId, status) }
}
