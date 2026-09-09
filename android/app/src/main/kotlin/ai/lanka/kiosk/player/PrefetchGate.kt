package ai.lanka.kiosk.player

import kotlin.math.min

/**
 * Retry schedule for the interrupt clip's pre-download — a 1:1 port of the
 * `clipRetry` state in `useReconciler.ts`.
 *
 * `MediaCache.downloadSync` blocks the calling thread for the whole fetch. A
 * clip that never lands (the storage guard skipped it, a truncated CDN object
 * fails the hash) used to be re-fetched on EVERY 30 s poll, forever. The clip
 * is needed at 09:00, not now, so back off in minutes and reset only when the
 * sha changes or a download lands.
 */
class PrefetchGate {
    private var sha: String? = null
    private var attempts = 0
    private var nextTryAt = 0L

    @Synchronized
    fun shouldTry(sha256: String, nowMs: Long): Boolean {
        if (sha != sha256) return true // a new clip gets a fresh budget
        return nowMs >= nextTryAt
    }

    @Synchronized
    fun failed(sha256: String, nowMs: Long) {
        if (sha != sha256) { sha = sha256; attempts = 0 }
        nextTryAt = nowMs + delay(attempts)
        attempts += 1
    }

    @Synchronized
    fun succeeded(sha256: String) {
        if (sha == sha256) { sha = null; attempts = 0; nextTryAt = 0L }
    }

    private companion object {
        const val BASE_MS = 60_000L
        const val MAX_MS = 60 * 60_000L
        fun delay(attempt: Int): Long = min(BASE_MS * (1L shl min(attempt, 20)), MAX_MS)
    }
}
