package ai.lanka.kiosk

import java.security.MessageDigest

/**
 * Pure decision logic for the on-device PIN escape hatch: digit accumulation,
 * hash comparison, failure counting and the lockout window.
 *
 * Deliberately free of Android imports so it runs under plain JVM unit tests
 * (same pattern as the native player's pure cores). All Android concerns —
 * drawing, key events, unlocking the kiosk — live in PinPadView/KioskActivity.
 *
 * There is ONE instance per process (KioskActivity.companion). The pad is
 * created and destroyed on every open/close, but the failure counter and
 * lockout window must outlive it — otherwise closing and reopening the pad
 * hands an attacker five fresh attempts every time.
 *
 * @param expectedSha256 lowercase hex sha256 of the PIN; EMPTY disables the
 *   feature entirely, so an APK built without -PKIOSK_PIN has no hatch at all.
 * @param pinLength number of digits; entry is compared once this many arrive.
 * @param now injected clock so lockout expiry is deterministic in tests.
 */
class KioskPin(
    private val expectedSha256: String,
    private val pinLength: Int,
    private val now: () -> Long = System::currentTimeMillis
) {
    enum class Result {
        /** Digit accepted (or ignored), more needed. */
        INCOMPLETE,
        /** Full entry matched — caller should unlock. */
        UNLOCKED,
        /** Full entry did not match; entry cleared. */
        WRONG,
        /** Rejected: lockout window is active. */
        LOCKED_OUT
    }

    private val entry = StringBuilder()
    private var failures = 0
    private var lockedOutUntil = 0L

    val enabled: Boolean get() = expectedSha256.isNotEmpty() && pinLength > 0

    val entryLength: Int get() = entry.length

    fun lockedOutMsRemaining(): Long = (lockedOutUntil - now()).coerceAtLeast(0L)

    fun isLockedOut(): Boolean = lockedOutMsRemaining() > 0L

    /** Clears the partial entry only. Failure count and lockout are untouched. */
    fun reset() {
        entry.setLength(0)
    }

    fun append(digit: Char): Result {
        if (isLockedOut()) return Result.LOCKED_OUT
        if (!enabled) return Result.WRONG
        if (!digit.isDigit()) return Result.INCOMPLETE

        entry.append(digit)
        if (entry.length < pinLength) return Result.INCOMPLETE

        val matched = sha256(entry.toString()).equals(expectedSha256, ignoreCase = true)
        entry.setLength(0)

        return if (matched) {
            failures = 0
            Result.UNLOCKED
        } else {
            failures++
            if (failures >= MAX_FAILURES) {
                lockedOutUntil = now() + LOCKOUT_MS
                failures = 0
            }
            Result.WRONG
        }
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val MAX_FAILURES = 5
        const val LOCKOUT_MS = 60_000L
    }
}
