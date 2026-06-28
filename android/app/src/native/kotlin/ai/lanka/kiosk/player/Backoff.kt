package ai.lanka.kiosk.player

import kotlin.math.min

/** Exponential backoff capped at 30s. Reset attempt to 0 on success. */
fun backoff(attempt: Int): Long = min(1000L * (1L shl attempt), 30_000L)
