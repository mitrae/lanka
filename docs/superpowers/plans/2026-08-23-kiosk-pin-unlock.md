# Kiosk PIN Unlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator take a box out of kiosk mode from the remote control with a locally-verified PIN, with no network involved.

**Architecture:** All code lands in `android/app/src/main/`, the source set shared by both product flavors, so `webview` and `native` inherit one implementation. Long-press BACK (or five BACK taps in 2 s) attaches a native, non-focusable `PinPadView` over the player via `Activity.addContentView()`; while it is showing, `KioskActivity.dispatchKeyEvent` routes every key to it and nothing else. A correct PIN clears `KioskLock.locked` — which now drives lock-task state through a listener — verifies the task is unpinned, then launches Android Settings. Pure decision logic lives in `KioskPin` and `TapChord`, which have zero Android imports and are JVM-unit-tested.

**Tech Stack:** Kotlin, Android SDK 34 (minSdk 24), Gradle Kotlin DSL, JUnit 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-kiosk-pin-unlock-design.md` (revised after Claude + Codex review — read the "Key routing" and "Latent bugs fixed" sections before Tasks 3, 5 and 6).

## Global Constraints

- **All new production code goes in `android/app/src/main/kotlin/ai/lanka/kiosk/`.** Never `src/webview/` or `src/native/` — the feature must be identical in both flavors.
- **All new tests go in `android/app/src/test/kotlin/ai/lanka/kiosk/`.** Never `src/testNative/` — that source set compiles only into the native flavor, and these classes are shared. Putting a shared-class test there hides it from `testWebviewDebugUnitTest`.
- **Test style:** JUnit 4, `import org.junit.Assert.*`, backtick-quoted test method names. Match `app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt`.
- **No new Gradle dependencies.** `junit:junit:4.13.2` is already `testImplementation`.
- **Both flavors must build and test green** after every task: `./gradlew test` runs `testWebviewDebugUnitTest` and `testNativeDebugUnitTest`.
- **`KIOSK_PIN` default is the empty string**, which disables the feature. An APK built without `-PKIOSK_PIN` must have no PIN escape hatch, not a well-known one.
- **Lockout policy:** 5 consecutive wrong entries → 60 000 ms lockout. **The lockout state is process-wide** and must survive the pad being closed and reopened.
- **PIN pad auto-dismiss:** 20 000 ms with no accepted key (initial DOWN events only).
- **Fallback trigger:** 5 BACK taps within 2 000 ms.
- **The pad never takes Android focus.** No view inside it may be `focusable`. All key handling goes through `PinPadView.handleKey()` called from `KioskActivity.dispatchKeyEvent`.
- **Every key action in the pad requires `ACTION_DOWN && repeatCount == 0`.** Auto-repeats must never dismiss the pad or enter a digit.
- Working directory for all Gradle commands is `android/`.

---

### Task 1: `KioskPin` and `TapChord` — pure state machines

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskPin.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/TapChord.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/KioskPinTest.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/TapChordTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class KioskPin(expectedSha256: String, pinLength: Int, now: () -> Long = System::currentTimeMillis)` with `enum class Result { INCOMPLETE, UNLOCKED, WRONG, LOCKED_OUT }`, `val enabled: Boolean`, `val entryLength: Int`, `fun append(digit: Char): Result`, `fun isLockedOut(): Boolean`, `fun lockedOutMsRemaining(): Long`, `fun reset()`.
  - `class TapChord(taps: Int, windowMs: Long, now: () -> Long = System::currentTimeMillis)` with `fun tap(): Boolean`.
  - Task 5 (`PinPadView`) and Task 6 (`KioskActivity`) depend on these exact names.

- [ ] **Step 1: Write the failing `KioskPin` test**

Create `android/app/src/test/kotlin/ai/lanka/kiosk/KioskPinTest.kt`:

```kotlin
package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class KioskPinTest {

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }

    private class FakeClock(var nowMs: Long = 0L) { fun get(): Long = nowMs }

    private fun pin(value: String = "4931", clock: FakeClock = FakeClock()) =
        KioskPin(sha256(value), value.length, clock::get)

    private fun type(p: KioskPin, digits: String): KioskPin.Result {
        var last = KioskPin.Result.INCOMPLETE
        for (c in digits) last = p.append(c)
        return last
    }

    @Test
    fun `correct pin unlocks`() {
        assertEquals(KioskPin.Result.UNLOCKED, type(pin(), "4931"))
    }

    @Test
    fun `partial entry is incomplete`() {
        val p = pin()
        assertEquals(KioskPin.Result.INCOMPLETE, type(p, "493"))
        assertEquals(3, p.entryLength)
    }

    @Test
    fun `wrong pin reports wrong and clears entry`() {
        val p = pin()
        assertEquals(KioskPin.Result.WRONG, type(p, "0000"))
        assertEquals(0, p.entryLength)
    }

    @Test
    fun `lockout engages on fifth consecutive failure`() {
        val p = pin()
        repeat(4) { assertEquals(KioskPin.Result.WRONG, type(p, "0000")) }
        assertFalse(p.isLockedOut())
        assertEquals(KioskPin.Result.WRONG, type(p, "0000"))
        assertTrue(p.isLockedOut())
    }

    @Test
    fun `input during lockout is rejected without extending it`() {
        val clock = FakeClock()
        val p = pin(clock = clock)
        repeat(5) { type(p, "0000") }
        clock.nowMs = 30_000
        assertEquals(KioskPin.Result.LOCKED_OUT, p.append('4'))
        assertEquals(30_000L, p.lockedOutMsRemaining())
    }

    @Test
    fun `lockout expires on the injected clock`() {
        val clock = FakeClock()
        val p = pin(clock = clock)
        repeat(5) { type(p, "0000") }
        clock.nowMs = 60_000
        assertFalse(p.isLockedOut())
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
    }

    @Test
    fun `success resets the failure counter`() {
        val p = pin()
        repeat(4) { type(p, "0000") }
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
        repeat(4) { assertEquals(KioskPin.Result.WRONG, type(p, "0000")) }
        assertFalse(p.isLockedOut())
    }

    @Test
    fun `reset clears entry but keeps failure state`() {
        val p = pin()
        repeat(4) { type(p, "0000") }
        type(p, "49")
        p.reset()
        assertEquals(0, p.entryLength)
        // 4 failures survived reset → this 5th one locks out
        assertEquals(KioskPin.Result.WRONG, type(p, "0000"))
        assertTrue(p.isLockedOut())
    }

    @Test
    fun `non-digit characters are ignored`() {
        val p = pin()
        assertEquals(KioskPin.Result.INCOMPLETE, p.append('x'))
        assertEquals(0, p.entryLength)
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
    }

    @Test
    fun `empty expected hash disables the feature`() {
        val p = KioskPin("", 0) { 0L }
        assertFalse(p.enabled)
        assertEquals(KioskPin.Result.WRONG, p.append('4'))
    }

    @Test
    fun `hash comparison is case insensitive`() {
        val p = KioskPin(sha256("4931").uppercase(), 4) { 0L }
        assertEquals(KioskPin.Result.UNLOCKED, type(p, "4931"))
    }
}
```

- [ ] **Step 2: Write the failing `TapChord` test**

Create `android/app/src/test/kotlin/ai/lanka/kiosk/TapChordTest.kt`:

```kotlin
package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test

class TapChordTest {

    private class FakeClock(var nowMs: Long = 0L) { fun get(): Long = nowMs }

    @Test
    fun `fires on the nth tap inside the window and resets`() {
        val clock = FakeClock()
        val chord = TapChord(taps = 5, windowMs = 2_000, now = clock::get)
        repeat(4) { clock.nowMs += 200; assertFalse(chord.tap()) }
        clock.nowMs += 200
        assertTrue(chord.tap())
        // counter reset: the next tap starts over
        clock.nowMs += 200
        assertFalse(chord.tap())
    }

    @Test
    fun `taps outside the window are forgotten`() {
        val clock = FakeClock()
        val chord = TapChord(taps = 5, windowMs = 2_000, now = clock::get)
        repeat(4) { clock.nowMs += 100; chord.tap() }
        clock.nowMs += 2_500 // everything above is now stale
        assertFalse(chord.tap())
        repeat(3) { clock.nowMs += 100; assertFalse(chord.tap()) }
        clock.nowMs += 100
        assertTrue(chord.tap()) // 5 fresh taps within 2 s
    }

    @Test
    fun `one short of n never fires`() {
        val clock = FakeClock()
        val chord = TapChord(taps = 5, windowMs = 2_000, now = clock::get)
        repeat(4) { clock.nowMs += 100; assertFalse(chord.tap()) }
    }
}
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd android && ./gradlew testWebviewDebugUnitTest --tests '*KioskPinTest*' --tests '*TapChordTest*'`
Expected: FAIL — compilation errors, `Unresolved reference: KioskPin` and `Unresolved reference: TapChord`.

- [ ] **Step 4: Write `KioskPin`**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/KioskPin.kt`:

```kotlin
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
```

- [ ] **Step 5: Write `TapChord`**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/TapChord.kt`:

```kotlin
package ai.lanka.kiosk

/**
 * Counts taps and fires once [taps] have landed inside a sliding [windowMs].
 * Backs the PIN pad's fallback trigger (5× BACK in 2 s) for ROMs that reserve
 * long-press BACK and IR remotes that never auto-repeat. Pure Kotlin; the
 * injected clock keeps it deterministic under test.
 */
class TapChord(
    private val taps: Int,
    private val windowMs: Long,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val times = ArrayDeque<Long>()

    /** Records a tap. Returns true (and resets) when the chord completes. */
    fun tap(): Boolean {
        val t = now()
        times.addLast(t)
        while (times.isNotEmpty() && t - times.first() > windowMs) times.removeFirst()
        if (times.size >= taps) {
            times.clear()
            return true
        }
        return false
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd android && ./gradlew test --tests '*KioskPinTest*' --tests '*TapChordTest*'`
Expected: PASS, in **both** `testWebviewDebugUnitTest` and `testNativeDebugUnitTest`. If the native variant reports "no tests found", the files landed in the wrong source set — they must be in `src/test/`, not `src/testNative/`.

- [ ] **Step 7: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/KioskPin.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/TapChord.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/KioskPinTest.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/TapChordTest.kt
git commit -m "feat(kiosk): KioskPin + TapChord — pure PIN entry / tap-chord state machines"
```

---

### Task 2: `KioskLock` gains a change listener

Today `KioskLock.locked` is a bare flag that nothing observes, which is why the dashboard's `kiosk-unlock` command never releases lock task. This task makes the flag observable; Task 3 attaches the behaviour.

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskLock.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/KioskLockTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `KioskLock.listener: ((Boolean) -> Unit)?`. Assigning `KioskLock.locked` now invokes `listener` with the new value. Task 3 registers this from `KioskActivity`.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/kotlin/ai/lanka/kiosk/KioskLockTest.kt`. Note the `@After` — `KioskLock` is a process-wide `object`, so leaked state between tests would cause order-dependent failures.

```kotlin
package ai.lanka.kiosk

import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class KioskLockTest {

    @After
    fun restoreDefaults() {
        KioskLock.listener = null
        KioskLock.locked = true
    }

    @Test
    fun `defaults to locked`() {
        assertTrue(KioskLock.locked)
    }

    @Test
    fun `setting locked notifies the listener with the new value`() {
        val seen = mutableListOf<Boolean>()
        KioskLock.listener = { seen.add(it) }
        KioskLock.locked = false
        KioskLock.locked = true
        assertEquals(listOf(false, true), seen)
    }

    @Test
    fun `a cleared listener is not called`() {
        val seen = mutableListOf<Boolean>()
        KioskLock.listener = { seen.add(it) }
        KioskLock.listener = null
        KioskLock.locked = false
        assertTrue(seen.isEmpty())
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd android && ./gradlew testWebviewDebugUnitTest --tests '*KioskLockTest*'`
Expected: FAIL — compilation error, `Unresolved reference: listener`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `android/app/src/main/kotlin/ai/lanka/kiosk/KioskLock.kt` with:

```kotlin
package ai.lanka.kiosk

/**
 * Process-wide kiosk-lock flag, toggled remotely via the dashboard
 * (`kiosk-lock` / `kiosk-unlock` command → NativeFSBridge.setKioskLock) or
 * locally by the on-device PIN pad (see KioskPin / PinPadView).
 *
 * When locked (the default), the snap-back watchdog re-foregrounds the player and
 * BACK is swallowed. When unlocked, both are disabled so an operator can leave the
 * app for maintenance. Intentionally NOT persisted: the box always boots LOCKED
 * (fail-safe) — an unlock is a temporary maintenance window for the current run.
 *
 * [listener] lets the foreground KioskActivity mirror the flag into real
 * lock-task state, so an unlock from ANY source (dashboard or PIN pad) actually
 * releases the pin. Without it the flag and the OS disagree on a device-owner
 * box: BACK starts working but the task stays pinned.
 *
 * The listener receives the value that was just assigned, but observers should
 * RE-READ [locked] when they act (KioskActivity does): a callback posted to the
 * main thread may run after a later assignment, and applying the captured
 * value would then roll state backwards.
 *
 * A plain object (not tied to the Activity lifecycle) so the bridge and any
 * recreated MainActivity instance share one value.
 */
object KioskLock {
    /** Invoked with the new value whenever [locked] is assigned. */
    @Volatile
    var listener: ((Boolean) -> Unit)? = null

    @Volatile
    var locked: Boolean = true
        set(value) {
            field = value
            listener?.invoke(value)
        }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd android && ./gradlew test --tests '*KioskLockTest*'`
Expected: PASS in both flavors.

- [ ] **Step 5: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/KioskLock.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/KioskLockTest.kt
git commit -m "feat(kiosk): make KioskLock observable via a change listener"
```

---

### Task 3: Lock-task state follows the flag (fixes two latent bugs)

This task is independently valuable and ships a fix even if the PIN pad never lands. Both defects exist today:

1. `KioskActivity.onResume` calls `DevicePolicy.startKioskMode(this)` unconditionally, so any unlock is undone on the next resume.
2. Nothing ever calls `stopLockTask()`, so the dashboard `kiosk-unlock` command is a no-op on a pinned box.

Four rules from the spec's "Latent bugs fixed" section are encoded here: reconcile unconditionally on resume; posted work re-reads the flag; posted work checks it is still the registered observer; `onPause` clears only its own listener. Both flavors wipe `mainHandler` in `onDestroy` (`MainActivity.kt:102`, `PlayerActivity.kt:273`) and `MainActivity.kt:93` does so mid-life during renderer recovery — reconcile-on-resume is what makes losing a queued post harmless.

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/DevicePolicy.kt` (replace `startKioskMode` at lines 112-117; add two functions after it)
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt:22-27` (`onResume`) and add `onPause`

**Interfaces:**
- Consumes: `KioskLock.listener` from Task 2.
- Produces: `DevicePolicy.isLockTaskActive(activity: Activity): Boolean`, `DevicePolicy.stopKioskMode(activity: Activity): Boolean`, and in `KioskActivity` a `private fun applyLockState()`. Task 6 relies on `KioskLock.locked = false` synchronously releasing lock task when assigned on the main thread, then on `isLockTaskActive` to verify.

- [ ] **Step 1: Add the lock-task helpers to `DevicePolicy`**

In `android/app/src/main/kotlin/ai/lanka/kiosk/DevicePolicy.kt`, replace the existing `startKioskMode` function (lines 112-117) and add the two new ones, so the block reads:

```kotlin
    /** True while this app's task is pinned (screen pinning) or locked (device-owner lock task). */
    fun isLockTaskActive(activity: Activity): Boolean {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    fun startKioskMode(activity: Activity) {
        if (isLockTaskActive(activity)) return
        runCatching { activity.startLockTask() }
            .onFailure { Log.w(TAG, "startLockTask: ${it.message}") }
    }

    /**
     * Releases the lock-task pin so an operator can leave the player. Returns
     * true if the task is actually unpinned afterwards — stopLockTask() validates
     * task/UID ownership and an OEM can refuse it, and an escape hatch must never
     * report success it cannot verify.
     *
     * Guarded by the current lock-task state (mirroring [startKioskMode]) rather
     * than by device-owner status: [startKioskMode] also pins UNprovisioned boxes
     * via plain screen pinning, so gating the release on isDeviceOwner would
     * strand exactly those devices.
     */
    fun stopKioskMode(activity: Activity): Boolean {
        if (!isLockTaskActive(activity)) return true
        runCatching { activity.stopLockTask() }
            .onFailure { Log.w(TAG, "stopLockTask: ${it.message}") }
        return !isLockTaskActive(activity)
    }
```

Keep the existing KDoc comment above `startKioskMode` as it is. No new imports are needed — `Activity`, `ActivityManager`, `Context` and `Log` are already imported.

- [ ] **Step 2: Wire the listener in `KioskActivity`**

In `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`, add these members alongside `kioskReturnRunnable`:

```kotlin
    /**
     * Mirrors KioskLock into real lock-task state so an unlock from ANY source
     * (dashboard command or PIN pad) takes effect.
     *
     * Runs inline when already on the main thread and hops the handler otherwise:
     * startLockTask/stopLockTask are main-thread-only, but the dashboard path sets
     * the flag off-thread (NativeFSBridge on a JavaBridge thread, the native
     * CommandDispatcher on the WebSocket thread). Running inline on the main
     * thread also guarantees ordering for the PIN unlock, which must release the
     * pin BEFORE it can startActivity() to another package.
     */
    private val lockListener: (Boolean) -> Unit = {
        if (Looper.myLooper() == Looper.getMainLooper()) applyLockState()
        else mainHandler.post { applyLockState() }
    }

    /**
     * Applies the CURRENT flag — re-read here, never captured — so a post queued
     * before a later assignment cannot roll state backwards. Bails unless this
     * Activity is still the registered observer, so a post that lands after
     * onPause never pins/unpins a backgrounded instance.
     */
    private fun applyLockState() {
        if (KioskLock.listener !== lockListener || isFinishing) return
        if (KioskLock.locked) DevicePolicy.startKioskMode(this)
        else DevicePolicy.stopKioskMode(this)
    }
```

Then replace `onResume` (currently lines 22-27) with:

```kotlin
    override fun onResume() {
        super.onResume()
        KioskLock.listener = lockListener
        // Reconcile UNCONDITIONALLY. A dashboard unlock that arrived while we
        // were paused fired with no listener registered; an `if (locked)` guard
        // here would skip it and leave the task pinned with the flag saying
        // unlocked. This also recovers from onDestroy/renderer-recovery wiping
        // mainHandler, which drops any queued lock-state post.
        applyLockState()
        // Cancel a pending snap-back — we're already in front.
        mainHandler.removeCallbacks(kioskReturnRunnable)
    }

    override fun onPause() {
        super.onPause()
        // Clear only OUR listener — never silently deregister another instance's.
        if (KioskLock.listener === lockListener) KioskLock.listener = null
    }
```

`Looper` is already imported (`android.os.Looper`, used for `mainHandler`).

- [ ] **Step 3: Verify both flavors still compile and all tests pass**

Run: `cd android && ./gradlew assembleWebviewDebug assembleNativeDebug test`
Expected: BUILD SUCCESSFUL, all existing tests green. There is no unit test for this task — `startLockTask`/`stopLockTask` need a real Activity, so this is build-verified here and confirmed on-box in Task 7, matching how the project already treats Activity-level code.

- [ ] **Step 4: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/DevicePolicy.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt
git commit -m "fix(kiosk): make lock-task state follow KioskLock

onResume re-pinned unconditionally, undoing any unlock, and nothing ever
called stopLockTask() — so the dashboard kiosk-unlock command was a no-op
on a pinned box. Both paths now mirror the flag; resume reconciles
unconditionally and posted work re-reads the flag under an identity guard."
```

---

### Task 4: `KIOSK_PIN` build property

**Files:**
- Modify: `android/app/build.gradle.kts:29-38` (`defaultConfig`)
- Modify: `android/README.md` (kiosk-hardening section)

**Interfaces:**
- Consumes: nothing.
- Produces: `BuildConfig.KIOSK_PIN_SHA256: String` (lowercase hex, empty when unset) and `BuildConfig.KIOSK_PIN_LENGTH: Int` (0 when unset). Task 6 constructs `KioskPin` from these.

- [ ] **Step 1: Add the BuildConfig fields**

In `android/app/build.gradle.kts`, inside `defaultConfig`, directly after the existing `LANKA_SERVER_URL` `buildConfigField` block:

```kotlin
        // On-device PIN escape hatch (see docs/superpowers/specs/2026-08-23-kiosk-pin-unlock-design.md).
        // Hashed at configure time so the plaintext PIN never ships in the APK.
        // Empty default = feature DISABLED, so a build without -PKIOSK_PIN has no
        // hatch at all rather than a fleet-wide well-known one.
        val kioskPin = providers.gradleProperty("KIOSK_PIN").getOrElse("")
        val kioskPinSha = if (kioskPin.isEmpty()) "" else
            java.security.MessageDigest.getInstance("SHA-256")
                .digest(kioskPin.toByteArray())
                .joinToString("") { "%02x".format(it) }
        buildConfigField("String", "KIOSK_PIN_SHA256", "\"$kioskPinSha\"")
        buildConfigField("int", "KIOSK_PIN_LENGTH", "${kioskPin.length}")
```

- [ ] **Step 2: Verify the fields are generated, with and without the property**

Compute the expected hash independently first, then compare the generated source against it exactly:

```bash
cd android
printf 4931 | sha256sum
# → abe0ccdc1f6402ee65627d5f95700af1e5914d113f02db83567212fa036f54d2
./gradlew assembleWebviewDebug -PKIOSK_PIN=4931
grep "KIOSK_PIN" app/build/generated/source/buildConfig/webview/debug/ai/lanka/kiosk/BuildConfig.java
```

Expected — these two lines (AGP emits BuildConfig fields alphabetically, so LENGTH comes first; ignore indentation):

```
public static final int KIOSK_PIN_LENGTH = 4;
public static final String KIOSK_PIN_SHA256 = "abe0ccdc1f6402ee65627d5f95700af1e5914d113f02db83567212fa036f54d2";
```

(The `webview/debug/` path is AGP 8.2.2's layout, as used by this project.) Confirm the literal PIN does **not** appear:

```bash
grep -c '"4931"' app/build/generated/source/buildConfig/webview/debug/ai/lanka/kiosk/BuildConfig.java
```

Expected: `0`.

Then confirm the disabled default:

```bash
./gradlew assembleWebviewDebug
grep "KIOSK_PIN" app/build/generated/source/buildConfig/webview/debug/ai/lanka/kiosk/BuildConfig.java
```

Expected: `KIOSK_PIN_SHA256 = ""` and `KIOSK_PIN_LENGTH = 0`.

- [ ] **Step 3: Document the property**

In `android/README.md`, in the "Kiosk hardening WITHOUT device owner (per box)" section, add after the existing `appops` block:

```markdown
### On-device PIN escape hatch

Bake a PIN into the build so a box can be taken out of kiosk mode from the
remote when the dashboard is unreachable (tailnet down, WebSocket wedged,
app server offline):

```bash
./gradlew :app:assembleNativeDebug \
  -PLANKA_SERVER_URL=http://lanka-server:3000 \
  -PKIOSK_PIN=4931
```

**Long-press BACK** on the remote — or, if the ROM reserves long-BACK or the
remote never auto-repeats, **tap BACK five times within 2 s** — opens a PIN pad
over the player. A correct PIN clears the kiosk lock, releases lock task, and
opens Android Settings — the last part matters on a device-owner box, where
Lanka is the HOME launcher and there would otherwise be nowhere to navigate to.

- The PIN is stored as a **sha256** in `BuildConfig`, so `strings` on the APK
  does not reveal it. This is friction, not security: four digits brute-force
  offline instantly for anyone holding the APK. The real control is that
  having the APK already implies fleet access.
- **Omitting `-PKIOSK_PIN` disables the feature** — neither trigger does
  anything. There is no default PIN.
- 5 wrong entries trigger a 60 s lockout that survives closing and reopening
  the pad. The pad auto-dismisses after 20 s idle.
- The unlock lasts until reboot, matching the dashboard `kiosk-unlock` command.
  Rebooting always returns the box to locked.
```

- [ ] **Step 4: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/build.gradle.kts android/README.md
git commit -m "feat(kiosk): -PKIOSK_PIN build property, hashed into BuildConfig"
```

---

### Task 5: `PinPadView` — non-focusable, self-drawn selection

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/PinPadView.kt`

**Interfaces:**
- Consumes: `KioskPin` and `KioskPin.Result` from Task 1.
- Produces: `class PinPadView(context: Context, pin: KioskPin, onUnlock: () -> Unit, onDismiss: () -> Unit) : LinearLayout` with `fun handleKey(event: KeyEvent): Boolean` and `fun showMessage(text: String)`. Task 6 constructs it with exactly these four arguments and calls exactly these two methods.

The pad **never participates in Android focus**: no view in it is focusable, and it does not override `dispatchKeyEvent`. Keys arrive only via `handleKey`, called by `KioskActivity.dispatchKeyEvent` (Task 6). Selection is a plain index the pad draws itself — no `FocusFinder`, so a D-pad press can never wander into the WebView or the native flavor's controller-enabled `PlayerView`s.

- [ ] **Step 1: Write the implementation**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/PinPadView.kt`:

```kotlin
package ai.lanka.kiosk

import android.content.Context
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Full-screen PIN entry overlay drawn OVER the player by KioskActivity via
 * addContentView(). Deliberately a native View rather than an HTML overlay in
 * the web player: the escape hatch is most needed exactly when the WebView
 * renderer has died or JS is wedged, and a native view still draws then.
 *
 * NEVER takes focus. KioskActivity.dispatchKeyEvent routes every key here via
 * [handleKey] while the pad is showing; selection is a plain index drawn by
 * the pad itself. Holds no policy — every decision is delegated to [pin].
 *
 * Grid (selection indices):  1 2 3 / 4 5 6 / 7 8 9 / _ 0 _
 *                            0 1 2   3 4 5   6 7 8     9
 */
class PinPadView(
    context: Context,
    private val pin: KioskPin,
    private val onUnlock: () -> Unit,
    private val onDismiss: () -> Unit
) : LinearLayout(context) {

    private val dots = textView(32f, Color.WHITE)
    private val message = textView(14f, Color.LTGRAY)
    private val keys = ArrayList<TextView>(10)
    private var selected = 4 // start on "5", the middle of the grid

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(SCRIM)
        isFocusable = false
        isFocusableInTouchMode = false

        addView(textView(20f, Color.WHITE).apply {
            text = "Enter PIN"
            setPadding(0, 0, 0, dp(12))
        })
        addView(dots)
        addView(row('1', '2', '3'))
        addView(row('4', '5', '6'))
        addView(row('7', '8', '9'))
        addView(row('0'))
        addView(message.apply { setPadding(0, dp(12), 0, 0) })

        render()
    }

    /** Replaces the message line (used for "Unlock failed — …"). */
    fun showMessage(text: String) {
        message.text = text
    }

    /**
     * Handles one hardware key. Acts only on an INITIAL press (ACTION_DOWN with
     * repeatCount == 0): the long-press BACK that opened the pad is still held
     * and its auto-repeats arrive here — without this check the pad would
     * dismiss itself before the finger lifts — and a held digit key would
     * otherwise enter "5555" and burn an attempt. Always returns true: the pad
     * is modal and nothing may leak to the player beneath.
     */
    fun handleKey(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return true
        when (val kc = event.keyCode) {
            KeyEvent.KEYCODE_BACK -> onDismiss()
            KeyEvent.KEYCODE_DPAD_LEFT -> move(dx = -1, dy = 0)
            KeyEvent.KEYCODE_DPAD_RIGHT -> move(dx = 1, dy = 0)
            KeyEvent.KEYCODE_DPAD_UP -> move(dx = 0, dy = -1)
            KeyEvent.KEYCODE_DPAD_DOWN -> move(dx = 0, dy = 1)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                submit(keys[selected].text[0])
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> submit('0' + (kc - KeyEvent.KEYCODE_0))
            in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 ->
                submit('0' + (kc - KeyEvent.KEYCODE_NUMPAD_0))
            else -> Unit
        }
        return true
    }

    // ── selection ──────────────────────────────────────────────────────────

    private fun move(dx: Int, dy: Int) {
        val row = if (selected == 9) 3 else selected / 3
        val col = if (selected == 9) 1 else selected % 3
        val next = when {
            dy == 1 -> if (row == 2) 9 else if (row < 2) selected + 3 else selected
            dy == -1 -> if (row == 3) 7 else if (row > 0) selected - 3 else selected
            dx != 0 && row == 3 -> selected // "0" has no horizontal neighbours
            else -> (col + dx).coerceIn(0, 2) + row * 3
        }
        selected = next
        render()
    }

    private fun submit(digit: Char) {
        when (pin.append(digit)) {
            KioskPin.Result.INCOMPLETE -> render()
            KioskPin.Result.UNLOCKED -> onUnlock()
            KioskPin.Result.WRONG -> {
                render()
                message.text = if (pin.isLockedOut()) lockoutText() else "Wrong PIN"
            }
            KioskPin.Result.LOCKED_OUT -> message.text = lockoutText()
        }
    }

    private fun lockoutText(): String =
        "Too many attempts — wait ${(pin.lockedOutMsRemaining() + 999) / 1000}s"

    private fun render() {
        dots.text = buildString { repeat(pin.entryLength) { append("● ") } }.trim().ifEmpty { "·" }
        keys.forEachIndexed { i, v -> v.setBackgroundColor(if (i == selected) HIGHLIGHT else Color.TRANSPARENT) }
        // Opened during an active lockout → say so immediately rather than on the next key.
        if (pin.isLockedOut()) message.text = lockoutText()
        else if (pin.entryLength > 0) message.text = ""
    }

    // ── construction ───────────────────────────────────────────────────────

    private fun row(vararg digits: Char): LinearLayout =
        LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER
            for (c in digits) addView(key(c).also { keys.add(it) })
        }

    private fun key(c: Char): TextView =
        textView(28f, Color.WHITE).apply {
            text = c.toString()
            isFocusable = false
            minWidth = dp(64)
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }

    private fun textView(sizeSp: Float, color: Int): TextView =
        TextView(context).apply {
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            gravity = Gravity.CENTER
            isFocusable = false
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private companion object {
        // NOT `const val` — 0xE6000000 is a Long literal, so .toInt() is not a
        // compile-time constant expression and `const` would fail to compile.
        val SCRIM = 0xE6000000.toInt()
        const val HIGHLIGHT = 0x40FFFFFF
    }
}
```

`keys` is filled in construction order — `row('1','2','3')`, `row('4','5','6')`, `row('7','8','9')`, `row('0')` — so `keys[0..8]` are `1..9` and `keys[9]` is `0`, matching the grid comment and `move()`.

- [ ] **Step 2: Verify both flavors compile**

Run: `cd android && ./gradlew assembleWebviewDebug assembleNativeDebug`
Expected: BUILD SUCCESSFUL. The view is exercised on-box in Task 7; there is no JVM test because instantiating a `View` needs an Android context, and the project keeps UI build-verified rather than Robolectric-tested.

- [ ] **Step 3: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/PinPadView.kt
git commit -m "feat(kiosk): PinPadView — non-focusable D-pad PIN entry overlay"
```

---

### Task 6: Wire the triggers, modal routing and verified unlock into `KioskActivity`

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`

**Interfaces:**
- Consumes: `KioskPin`, `TapChord` (Task 1), `KioskLock.listener` (Task 2), `DevicePolicy.isLockTaskActive` / `applyLockState` (Task 3), `BuildConfig.KIOSK_PIN_SHA256` / `BuildConfig.KIOSK_PIN_LENGTH` (Task 4), `PinPadView.handleKey` / `showMessage` (Task 5).
- Produces: the complete feature. Nothing depends on this task.

- [ ] **Step 1: Add the new imports**

At the top of `KioskActivity.kt`, add **only** these three — `Intent`, `Handler`, `Looper` and `KeyEvent` are already imported, and a duplicate `Intent` import must not be added:

```kotlin
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
```

- [ ] **Step 2: Replace the BACK key handling with both triggers**

The current `onKeyDown` returns `true` for BACK, which suppresses Android's long-press detection outright — `onKeyLongPress` can never fire without `startTracking()`. Replace it with the tracked-key pattern plus the tap chord:

```kotlin
    /**
     * Kiosk: a single BACK press from the remote must not tear the player down
     * (unless unlocked for maintenance). Two gestures open the PIN pad:
     *  - a LONG press — startTracking() is what makes onKeyLongPress fire at all;
     *  - five quick taps — for ROMs that reserve long-BACK (the app never sees a
     *    repeat) and IR remotes that emit discrete presses instead of holding.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) {
            if (event != null && event.repeatCount == 0) {
                event.startTracking()
                if (backTaps.tap()) showPinPad()
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) {
            showPinPad()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) return true
        return super.onKeyUp(keyCode, event)
    }
```

- [ ] **Step 3: Add the pad lifecycle, modal routing and verified unlock**

Add to `KioskActivity`:

```kotlin
    private var pinPad: PinPadView? = null
    private val backTaps = TapChord(taps = 5, windowMs = 2_000L)
    private val pinPadTimeout = Runnable { hidePinPad() }

    /**
     * MODAL routing: while the pad is showing, every key goes to it and nothing
     * else — super is deliberately not called, so nothing leaks to the WebView
     * or the player. Activity.dispatchKeyEvent is the entry point for every
     * hardware key in the window, ahead of the view hierarchy, so this cannot
     * be starved by focus sitting elsewhere. The idle timer restarts only on an
     * accepted initial press (not repeats, not UP).
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val pad = pinPad ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            mainHandler.removeCallbacks(pinPadTimeout)
            mainHandler.postDelayed(pinPadTimeout, PIN_PAD_IDLE_MS)
        }
        return pad.handleKey(event)
    }

    private fun showPinPad() {
        if (pinPad != null) return
        // No -PKIOSK_PIN at build time → no escape hatch. Fail safe, silently.
        if (!kioskPin.enabled) return

        kioskPin.reset() // clear any stale partial entry; failure state is kept
        val pad = PinPadView(this, kioskPin, onUnlock = ::onPinAccepted, onDismiss = ::hidePinPad)
        addContentView(
            pad,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        pinPad = pad
        mainHandler.postDelayed(pinPadTimeout, PIN_PAD_IDLE_MS)
    }

    private fun hidePinPad() {
        mainHandler.removeCallbacks(pinPadTimeout)
        pinPad?.let { (it.parent as? ViewGroup)?.removeView(it) }
        pinPad = null
    }

    /**
     * Order matters: the flag assignment runs the lock listener INLINE (we are on
     * the main thread), so lock task is released before startActivity — launching
     * another package while pinned is blocked. The release is then VERIFIED:
     * stopLockTask() can be refused (ownership, OEM), and an escape hatch must
     * never silently no-op. On failure the flag is restored to locked so it never
     * disagrees with the OS; the pad stays up with a message and re-entering the
     * PIN retries the release.
     */
    private fun onPinAccepted() {
        Log.i(TAG, "kiosk unlocked via on-device PIN")
        KioskLock.locked = false
        if (DevicePolicy.isLockTaskActive(this)) {
            // stopLockTask() was refused (ownership / OEM). Keep the flag and the OS
            // in agreement: a false flag would drop BACK-swallow and snap-back on a
            // box that is still pinned, and no resume will come to retry while the
            // task is pinned and foreground. The pad stays up; re-entering the PIN
            // retries the release.
            KioskLock.locked = true
            Log.w(TAG, "lock task still active after unlock — kept locked; Settings launch would be blocked")
            pinPad?.showMessage("Unlock failed — lock task still active")
            return
        }
        hidePinPad()
        runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
            .onFailure { Log.w(TAG, "settings launch failed: ${it.message}") }
    }
```

Replace the existing `companion object` with:

```kotlin
    companion object {
        private const val KIOSK_RETURN_MS = 400L
        private const val PIN_PAD_IDLE_MS = 20_000L
        private const val TAG = "LankaKiosk"

        /**
         * ONE per process. The pad is recreated on every open, but the failure
         * counter and lockout must survive that — and survive Activity recreation
         * (renderer-gone recovery) — or closing and reopening the pad hands out
         * five fresh attempts every time.
         */
        private val kioskPin: KioskPin by lazy {
            KioskPin(BuildConfig.KIOSK_PIN_SHA256, BuildConfig.KIOSK_PIN_LENGTH)
        }
    }
```

`LankaKiosk` matches a tag already captured by `NativeFSBridge.getLogs()`, so an unlock is retrievable later via the dashboard's **Pull logs** button. `BuildConfig` is generated into `ai.lanka.kiosk` for both flavors (the `namespace`), so no import is needed.

- [ ] **Step 4: Drop the pad when the Activity backgrounds**

Extend the `onPause` added in Task 3:

```kotlin
    override fun onPause() {
        super.onPause()
        // Clear only OUR listener — never silently deregister another instance's.
        if (KioskLock.listener === lockListener) KioskLock.listener = null
        hidePinPad()
    }
```

- [ ] **Step 5: Verify both flavors build and the full suite passes**

Run: `cd android && ./gradlew assembleWebviewDebug assembleNativeDebug test`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 6: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt
git commit -m "feat(kiosk): long-press or 5-tap BACK opens a modal PIN pad; verified unlock to Settings"
```

---

### Task 7: On-box verification and project docs

The project treats on-box verification as the real gate for anything touching kiosk behaviour or UI. This task is not optional.

**Files:**
- Modify: `CLAUDE.md` (repo root, "Android kiosk player (APK)" section)

- [x] **Step 1: Build and install a PIN-enabled APK**

```bash
cd android
./gradlew :app:assembleWebviewDebug -PLANKA_SERVER_URL=http://<box-reachable-host>:5100 -PKIOSK_PIN=4931
adb install -r app/build/outputs/apk/webview/debug/app-webview-debug.apk
adb shell am start -n ai.lanka.kiosk/.MainActivity
```

Verify against a **production build** of the server (`pnpm build` && `node .output/server/index.mjs`), not `pnpm dev` — the unbundled dev module graph is too heavy for these boxes.

- [ ] **Step 2: Walk the checklist on the box**

Triggers:
- [ ] Short-press BACK — player unaffected (unchanged behaviour).
- [ ] Long-press BACK — PIN pad appears over the player, "5" highlighted, **and stays up while BACK is still held** (regression check for the self-dismiss bug).
- [ ] Release, then five quick BACK taps — pad appears. Four taps, pause 3 s, one tap — it does not.
- [ ] Record which trigger(s) work on **each** remote in the fleet (Bluetooth Google TV remote, Tanix IR remote). If long-press never fires on a ROM, the 5-tap chord is the supported gesture there — note it in `android/README.md`.

Pad:
- [ ] D-pad moves the highlight; from "8" DOWN lands on "0", from "0" UP returns to "8"; LEFT/RIGHT on "0" do nothing.
- [ ] CENTER enters the highlighted digit; a number key on a keypad remote enters directly.
- [ ] **Hold a digit key for 2 s** — exactly one dot appears (regression check for auto-repeat entry).
- [ ] **In the `webview` flavor specifically**, D-pad keys move the pad highlight and do **not** scroll the page. **In the `native` flavor**, no ExoPlayer transport controls ever appear.
- [ ] Wrong PIN → "Wrong PIN", dots clear.
- [ ] 5 wrong entries → lockout message. Dismiss with BACK, reopen — **still locked out** (regression check for per-open lockout reset). After 60 s, input accepted again.
- [ ] Leave the pad untouched for 20 s → it disappears on its own.
- [ ] Reboot the box → kiosk is locked again, triggers still open the pad.
- [ ] Build without `-PKIOSK_PIN`, install — neither trigger does anything.

Unlock and what it is for:
- [ ] Correct PIN → Settings opens, player still running behind it.
- [ ] From Settings, BACK returns to the player and it does **not** snap back to kiosk (still unlocked).
- [ ] **On a device-owner box**, from Settings: Wi-Fi settings reachable, Tailscale app reachable, Developer options / wireless debugging reachable. These are the maintenance operations the hatch exists for — "Settings opened" alone is not a pass.
- [ ] Dashboard `kiosk-lock` while unlocked → box re-pins. Dashboard `kiosk-unlock` while the box is **asleep or in Settings**, then return to the player → it is unpinned (regression check for the paused-unlock bug).
- [ ] Dismiss the pad with BACK and **keep holding it** — confirm the pad does not reopen ~0.5 s later (a swallowed BACK-UP can leave `KeyEvent` tracking stale; if it reopens, record it — harmless but worth knowing).
- [ ] Five accidental BACK taps during playback → scrim appears; confirm BACK cancels it immediately (20 s of scrim is the accepted worst case).
- [ ] Dashboard `kiosk-unlock` **while the pad is showing** → pad stays up, remote dead except BACK; BACK dismisses; box is unpinned.
- [ ] Dashboard `kiosk-lock` **while the operator is still in Settings** → the player does NOT come back on its own (listener is deregistered while paused; re-lock applies on the next resume). This is expected — the earlier "kiosk-lock while unlocked → re-pins" line only passes with the player foregrounded.
- [ ] Repeat the core path on `assembleNativeDebug` (launch `ai.lanka.kiosk.vs/ai.lanka.kiosk.PlayerActivity`).

- [x] **Step 3: Update `CLAUDE.md`**

In the "Android kiosk player (APK)" section, add a bullet:

```markdown
- **On-device PIN escape hatch:** long-press BACK, or five BACK taps in 2 s,
  opens a native `PinPadView` over the player; a correct PIN (sha256-baked via
  `-PKIOSK_PIN`, empty default = disabled) clears `KioskLock`, releases lock
  task, **verifies** it is released, and opens Settings. All of it lives in
  `src/main` so both flavors share one implementation. The pad is a **native
  view, not HTML** (must work when the WebView renderer is dead) and it **never
  takes focus** — `KioskActivity.dispatchKeyEvent` routes every key to
  `PinPadView.handleKey()` while it is showing and calls nothing else. Every
  pad action requires `repeatCount == 0` (the opening long-press is still held
  when the pad appears). One `KioskPin` per process, so the lockout survives
  closing the pad. `KioskLock.locked` is now **listener-driven**: assigning it
  mirrors into real lock-task state via `KioskActivity`, which is what makes the
  dashboard's `kiosk-unlock` command actually work on a pinned box (it previously
  flipped the flag but never called `stopLockTask()`). `onResume` reconciles
  unconditionally, posted listener work re-reads the flag under an identity
  guard, and the dashboard sets the flag off-thread — `start/stopLockTask` are
  main-thread-only.
```

- [x] **Step 4: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add CLAUDE.md android/README.md
git commit -m "docs(kiosk): record the on-device PIN unlock in the project guide"
```

---

## Self-Review Notes

**Spec coverage:** every spec section maps to a task — `KioskPin` + `TapChord` → 1; `KioskLock` listener → 2; `isLockTaskActive` / `stopKioskMode: Boolean` / four listener rules / unconditional reconcile → 3; PIN storage / hashing / disabled default → 4; non-focusable pad, `handleKey`, `repeatCount == 0` rule, self-drawn selection, lockout shown on open → 5; both triggers, modal `dispatchKeyEvent` routing, idle timer on accepted presses only, verified unlock with failure message, Settings jump, process-wide `KioskPin`, logging → 6; testing → 1, 2 and Task 7's on-box gate (now including the maintenance-operations and regression checks); documentation → 4 and 7.

**Review findings folded in (Claude + Codex, 2026-08-23):** self-dismiss on the opening long-press and digit auto-repeat (Task 5 `repeatCount` rule); lost paused-unlock (Task 3 unconditional reconcile); focus-dependent routing (Tasks 5/6 modal design); fabricated SHA (Task 4 real value, computed independently); per-open lockout reset (Task 6 companion-held `KioskPin`); listener registration race and posts surviving `onPause` (Task 3 re-read + identity guard); unverified `stopLockTask` (Task 3 return value, Task 6 check); ROM-reserved long-BACK (Task 1/6 tap chord); duplicate `Intent` import (Task 6); non-digit input (Task 1). Deliberately **not** adopted: an `addListener/removeListener` API (one Activity at a time — the identity check suffices) and IME handling (the player page has no inputs).

**Deliberately not implemented** (spec non-goals): per-device PINs, server-delivered PINs, PIN rotation without a rebuild, unlock reporting to the server, automatic re-lock on a timer, a ticking lockout countdown.

**Type consistency:** `KioskPin.Result` members are identical in Tasks 1 and 5. `TapChord(taps, windowMs, now)` in Task 1 matches its Task 6 construction. `PinPadView`'s four-argument constructor and its `handleKey(KeyEvent): Boolean` / `showMessage(String)` match their Task 6 call sites. `DevicePolicy.isLockTaskActive(Activity)` and `stopKioskMode(Activity): Boolean` are defined in Task 3 and called in Tasks 3 and 6. `BuildConfig.KIOSK_PIN_SHA256` / `KIOSK_PIN_LENGTH` are produced in Task 4 and consumed in Task 6's companion.
