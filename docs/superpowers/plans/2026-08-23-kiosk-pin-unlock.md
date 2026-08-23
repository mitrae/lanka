# Kiosk PIN Unlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator take a box out of kiosk mode from the remote control with a locally-verified PIN, with no network involved.

**Architecture:** All code lands in `android/app/src/main/`, the source set shared by both product flavors, so `webview` and `native` inherit one implementation. A long-press on BACK attaches a native `PinPadView` over the player via `Activity.addContentView()`; a correct PIN clears `KioskLock.locked`, which now drives lock-task state through a listener, then launches Android Settings. Pure decision logic lives in `KioskPin`, which has zero Android imports and is JVM-unit-tested.

**Tech Stack:** Kotlin, Android SDK 34 (minSdk 24), Gradle Kotlin DSL, JUnit 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-kiosk-pin-unlock-design.md`

## Global Constraints

- **All new production code goes in `android/app/src/main/kotlin/ai/lanka/kiosk/`.** Never `src/webview/` or `src/native/` — the feature must be identical in both flavors.
- **All new tests go in `android/app/src/test/kotlin/ai/lanka/kiosk/`.** Never `src/testNative/` — that source set compiles only into the native flavor, and these classes are shared. Putting a shared-class test there hides it from `testWebviewDebugUnitTest`.
- **Test style:** JUnit 4, `import org.junit.Assert.*`, backtick-quoted test method names. Match `app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt`.
- **No new Gradle dependencies.** `junit:junit:4.13.2` is already `testImplementation`.
- **Both flavors must build and test green** after every task: `./gradlew test` runs `testWebviewDebugUnitTest` and `testNativeDebugUnitTest`.
- **`KIOSK_PIN` default is the empty string**, which disables the feature. An APK built without `-PKIOSK_PIN` must have no PIN escape hatch, not a well-known one.
- **Lockout policy:** 5 consecutive wrong entries → 60 000 ms lockout.
- **PIN pad auto-dismiss:** 20 000 ms of no key input.
- Working directory for all Gradle commands is `android/`.

---

### Task 1: `KioskPin` — pure PIN state machine

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskPin.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/KioskPinTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `class KioskPin(expectedSha256: String, pinLength: Int, now: () -> Long = System::currentTimeMillis)` with `enum class Result { INCOMPLETE, UNLOCKED, WRONG, LOCKED_OUT }`, `val enabled: Boolean`, `val entryLength: Int`, `fun append(digit: Char): Result`, `fun isLockedOut(): Boolean`, `fun lockedOutMsRemaining(): Long`, `fun reset()`. Task 5 (`PinPadView`) and Task 6 (`KioskActivity`) both depend on these exact names.

- [ ] **Step 1: Write the failing test**

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
    fun `reset clears entry without counting a failure`() {
        val p = pin()
        type(p, "49")
        p.reset()
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

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd android && ./gradlew testWebviewDebugUnitTest --tests '*KioskPinTest*'`
Expected: FAIL — compilation error, `Unresolved reference: KioskPin`.

- [ ] **Step 3: Write the implementation**

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
        /** Digit accepted, more needed. */
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

    /** Clears the current entry. Does NOT count as a failed attempt. */
    fun reset() {
        entry.setLength(0)
    }

    fun append(digit: Char): Result {
        if (isLockedOut()) return Result.LOCKED_OUT
        if (!enabled) return Result.WRONG

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

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd android && ./gradlew test --tests '*KioskPinTest*'`
Expected: PASS, in **both** `testWebviewDebugUnitTest` and `testNativeDebugUnitTest`. If the native variant reports "no tests found", the file landed in the wrong source set — it must be `src/test/`, not `src/testNative/`.

- [ ] **Step 5: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/KioskPin.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/KioskPinTest.kt
git commit -m "feat(kiosk): KioskPin — pure PIN entry state machine with lockout"
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

Replace the body of `android/app/src/main/kotlin/ai/lanka/kiosk/KioskLock.kt`, keeping the existing file header comment and extending it:

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

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/DevicePolicy.kt` (append `stopKioskMode` after `startKioskMode`, which ends at line 117)
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt:22-27` (`onResume`) and add `onPause`

**Interfaces:**
- Consumes: `KioskLock.listener` from Task 2.
- Produces: `DevicePolicy.stopKioskMode(activity: Activity)`. Task 6 relies on `KioskLock.locked = false` synchronously releasing lock task when assigned on the main thread.

- [ ] **Step 1: Add `stopKioskMode` to `DevicePolicy`**

Append to `android/app/src/main/kotlin/ai/lanka/kiosk/DevicePolicy.kt`, immediately after `startKioskMode` and before `reboot`:

```kotlin
    /**
     * Releases the lock-task pin so an operator can leave the player.
     *
     * Guarded by the current lock-task state (mirroring [startKioskMode]) rather
     * than by device-owner status: [startKioskMode] also pins UNprovisioned boxes
     * via plain screen pinning, so gating the release on isDeviceOwner would
     * strand exactly those devices.
     */
    fun stopKioskMode(activity: Activity) {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        if (am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) return
        runCatching { activity.stopLockTask() }
            .onFailure { Log.w(TAG, "stopLockTask: ${it.message}") }
    }
```

No new imports are needed — `Activity`, `ActivityManager`, `Context` and `Log` are already imported.

- [ ] **Step 2: Wire the listener in `KioskActivity`**

In `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`, add this property alongside `kioskReturnRunnable`:

```kotlin
    /**
     * Mirrors KioskLock into real lock-task state, so an unlock from ANY source
     * takes effect immediately.
     *
     * Runs inline when already on the main thread and hops the handler otherwise:
     * startLockTask/stopLockTask are main-thread-only, but the dashboard path sets
     * the flag off-thread (NativeFSBridge on a JavaBridge thread, the native
     * CommandDispatcher on the WebSocket thread). Running inline on the main
     * thread also guarantees ordering for the PIN unlock, which must release the
     * pin BEFORE it can startActivity() to another package.
     */
    private val lockListener: (Boolean) -> Unit = { locked ->
        if (Looper.myLooper() == Looper.getMainLooper()) applyLockState(locked)
        else mainHandler.post { applyLockState(locked) }
    }

    private fun applyLockState(locked: Boolean) {
        if (locked) DevicePolicy.startKioskMode(this) else DevicePolicy.stopKioskMode(this)
    }
```

Then replace `onResume` (currently lines 22-27) with:

```kotlin
    override fun onResume() {
        super.onResume()
        KioskLock.listener = lockListener
        // Enter lock task once the activity is foregrounded — but only while
        // locked, or an unlock would be silently undone on every resume.
        if (KioskLock.locked) DevicePolicy.startKioskMode(this)
        // Cancel a pending snap-back — we're already in front.
        mainHandler.removeCallbacks(kioskReturnRunnable)
    }

    override fun onPause() {
        super.onPause()
        // Don't leave a stale listener pointing at a backgrounded Activity.
        KioskLock.listener = null
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
on a pinned box. Both paths now mirror the flag."
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

```bash
cd android
./gradlew assembleWebviewDebug -PKIOSK_PIN=4931
grep -r "KIOSK_PIN" app/build/generated/source/buildConfig/webview/debug/ai/lanka/kiosk/BuildConfig.java
```

Expected: `KIOSK_PIN_SHA256 = "9e0f5a19b0d7a2e0a1f0e6b1c2d3..."` (the real sha256 of `4931`) and `KIOSK_PIN_LENGTH = 4`. Confirm the literal string `4931` does **not** appear:

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

**Long-press BACK** on the remote opens a PIN pad over the player. A correct
PIN clears the kiosk lock, releases lock task, and opens Android Settings —
the last part matters on a device-owner box, where Lanka is the HOME launcher
and there would otherwise be nowhere to navigate to.

- The PIN is stored as a **sha256** in `BuildConfig`, so `strings` on the APK
  does not reveal it. This is friction, not security: four digits brute-force
  offline instantly for anyone holding the APK. The real control is that
  having the APK already implies fleet access.
- **Omitting `-PKIOSK_PIN` disables the feature** — long-press BACK does
  nothing. There is no default PIN.
- 5 wrong entries trigger a 60 s lockout. The pad auto-dismisses after 20 s idle.
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

### Task 5: `PinPadView`

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/PinPadView.kt`

**Interfaces:**
- Consumes: `KioskPin` and `KioskPin.Result` from Task 1.
- Produces: `class PinPadView(context: Context, pin: KioskPin, onUnlock: () -> Unit, onDismiss: () -> Unit) : LinearLayout`. Task 6 constructs it with exactly these four arguments.

Built programmatically rather than from an XML layout: it keeps the whole component in one shared file and avoids adding resources that both flavors' manifests and resource merging would have to agree on.

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
 * Holds no policy — every decision is delegated to [pin].
 *
 * Two input styles, because TV remotes vary: D-pad to a digit + CENTER (which
 * Android turns into a click on the focused child), or a direct number key on
 * remotes that have a keypad.
 */
class PinPadView(
    context: Context,
    private val pin: KioskPin,
    private val onUnlock: () -> Unit,
    private val onDismiss: () -> Unit
) : LinearLayout(context) {

    private val dots = textView(32f, Color.WHITE)
    private val hint = textView(14f, Color.LTGRAY)
    private var firstDigit: TextView? = null

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(SCRIM)
        isFocusable = true
        isFocusableInTouchMode = true

        addView(textView(20f, Color.WHITE).apply {
            text = "Enter PIN"
            setPadding(0, 0, 0, dp(12))
        })
        addView(dots)
        for (row in ROWS) addView(digitRow(row))
        addView(hint.apply { setPadding(0, dp(12), 0, 0) })

        render()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Take focus off the WebView, which would otherwise eat D-pad keys for
        // its own page navigation and starve the pad.
        firstDigit?.requestFocus() ?: requestFocus()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            val kc = event.keyCode
            if (kc == KeyEvent.KEYCODE_BACK) {
                onDismiss()
                return true
            }
            if (kc in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
                submit('0' + (kc - KeyEvent.KEYCODE_0))
                return true
            }
        }
        // Everything else (D-pad movement, CENTER/ENTER clicks) falls through to
        // the normal view-hierarchy dispatch so focus navigation still works.
        return super.dispatchKeyEvent(event)
    }

    private fun submit(digit: Char) {
        when (pin.append(digit)) {
            KioskPin.Result.INCOMPLETE -> render()
            KioskPin.Result.UNLOCKED -> onUnlock()
            KioskPin.Result.WRONG -> {
                render()
                hint.text = if (pin.isLockedOut()) lockoutText() else "Wrong PIN"
            }
            KioskPin.Result.LOCKED_OUT -> hint.text = lockoutText()
        }
    }

    private fun lockoutText(): String =
        "Too many attempts — wait ${(pin.lockedOutMsRemaining() + 999) / 1000}s"

    private fun render() {
        dots.text = buildString {
            repeat(pin.entryLength) { append("● ") }
        }.trim().ifEmpty { "·" }
        if (pin.entryLength > 0) hint.text = ""
    }

    private fun digitRow(digits: String): LinearLayout =
        LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER
            for (c in digits) addView(digitButton(c).also { if (firstDigit == null) firstDigit = it })
        }

    private fun digitButton(c: Char): TextView =
        textView(28f, Color.WHITE).apply {
            text = c.toString()
            isFocusable = true
            isFocusableInTouchMode = true
            minWidth = dp(64)
            setPadding(dp(16), dp(10), dp(16), dp(10))
            // Visible focus ring — on a TV the remote user must see where they are.
            setOnFocusChangeListener { v, hasFocus ->
                v.setBackgroundColor(if (hasFocus) FOCUS else Color.TRANSPARENT)
            }
            setOnClickListener { submit(c) }
        }

    private fun textView(sizeSp: Float, color: Int): TextView =
        TextView(context).apply {
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            gravity = Gravity.CENTER
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private companion object {
        val ROWS = listOf("123", "456", "789", "0")
        // NOT `const val` — 0xE6000000 is a Long literal, so .toInt() is not a
        // compile-time constant expression and `const` would fail to compile.
        val SCRIM = 0xE6000000.toInt()
        const val FOCUS = 0x40FFFFFF
    }
}
```

- [ ] **Step 2: Verify both flavors compile**

Run: `cd android && ./gradlew assembleWebviewDebug assembleNativeDebug`
Expected: BUILD SUCCESSFUL. The view is exercised on-box in Task 7; there is no JVM test because instantiating a `View` needs an Android context, and the project keeps UI build-verified rather than Robolectric-tested.

- [ ] **Step 3: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add android/app/src/main/kotlin/ai/lanka/kiosk/PinPadView.kt
git commit -m "feat(kiosk): PinPadView — native D-pad PIN entry overlay"
```

---

### Task 6: Wire the trigger and unlock into `KioskActivity`

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`

**Interfaces:**
- Consumes: `KioskPin` (Task 1), `KioskLock.listener` (Task 2), `DevicePolicy.stopKioskMode` (Task 3), `BuildConfig.KIOSK_PIN_SHA256` / `BuildConfig.KIOSK_PIN_LENGTH` (Task 4), `PinPadView` (Task 5).
- Produces: the complete feature. Nothing depends on this task.

- [ ] **Step 1: Add the imports**

At the top of `KioskActivity.kt`, alongside the existing imports:

```kotlin
import android.content.Intent
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
```

`android.content.Intent`, `android.os.Handler`, `android.os.Looper` and `android.view.KeyEvent` are already imported.

- [ ] **Step 2: Replace the BACK key handling**

The current `onKeyDown` returns `true` for BACK, which suppresses Android's long-press detection outright — `onKeyLongPress` can never fire without `startTracking()`. Replace it with the tracked-key pattern:

```kotlin
    /** Kiosk: a single BACK press from the remote must not tear the player down
     *  (unless unlocked for maintenance). A LONG press opens the PIN pad — see
     *  showPinPad(). startTracking() is what makes onKeyLongPress fire at all. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) {
            if (event != null && event.repeatCount == 0) event.startTracking()
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

- [ ] **Step 3: Add the pad lifecycle and unlock**

Add to `KioskActivity`:

```kotlin
    private var pinPad: PinPadView? = null

    private val pinPadTimeout = Runnable { hidePinPad() }

    /** Any key press while the pad is up restarts its idle timer. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (pinPad != null) {
            mainHandler.removeCallbacks(pinPadTimeout)
            mainHandler.postDelayed(pinPadTimeout, PIN_PAD_IDLE_MS)
        }
        return super.dispatchKeyEvent(event)
    }

    private fun showPinPad() {
        if (pinPad != null) return
        val pin = KioskPin(BuildConfig.KIOSK_PIN_SHA256, BuildConfig.KIOSK_PIN_LENGTH)
        // No -PKIOSK_PIN at build time → no escape hatch. Fail safe, silently.
        if (!pin.enabled) return

        val pad = PinPadView(this, pin, onUnlock = ::onPinAccepted, onDismiss = ::hidePinPad)
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

    private fun onPinAccepted() {
        hidePinPad()
        Log.i(TAG, "kiosk unlocked via on-device PIN")
        // The listener registered in onResume runs INLINE here (we're on the main
        // thread), so lock task is released before the startActivity below —
        // launching another package while pinned would otherwise be blocked.
        KioskLock.locked = false
        runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
            .onFailure { Log.w(TAG, "settings launch failed: ${it.message}") }
    }
```

Extend the existing `companion object`:

```kotlin
    companion object {
        private const val KIOSK_RETURN_MS = 400L
        private const val PIN_PAD_IDLE_MS = 20_000L
        private const val TAG = "LankaKiosk"
    }
```

`LankaKiosk` matches a tag already captured by `NativeFSBridge.getLogs()`, so an unlock is retrievable later via the dashboard's **Pull logs** button.

- [ ] **Step 4: Drop the pad when the Activity backgrounds**

Extend the `onPause` added in Task 3:

```kotlin
    override fun onPause() {
        super.onPause()
        KioskLock.listener = null
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
git commit -m "feat(kiosk): long-press BACK opens the PIN pad; correct PIN unlocks to Settings"
```

---

### Task 7: On-box verification and project docs

The project treats on-box verification as the real gate for anything touching kiosk behaviour or UI. This task is not optional.

**Files:**
- Modify: `CLAUDE.md` (repo root, "Android kiosk player (APK)" section)

- [ ] **Step 1: Build and install a PIN-enabled APK**

```bash
cd android
./gradlew :app:assembleWebviewDebug -PLANKA_SERVER_URL=http://<box-reachable-host>:5100 -PKIOSK_PIN=4931
adb install -r app/build/outputs/apk/webview/debug/app-webview-debug.apk
adb shell am start -n ai.lanka.kiosk/.MainActivity
```

Verify against a **production build** of the server (`pnpm build` && `node .output/server/index.mjs`), not `pnpm dev` — the unbundled dev module graph is too heavy for these boxes.

- [ ] **Step 2: Walk the checklist on the box**

- [ ] Short-press BACK — player unaffected (unchanged behaviour).
- [ ] Long-press BACK — PIN pad appears over the player, first digit focused.
- [ ] D-pad moves focus between digits with a visible focus ring; CENTER enters a digit.
- [ ] **In the `webview` flavor specifically**, confirm D-pad keys reach the pad rather than scrolling the page. This is the single most likely failure. If focus is being stolen, the fallback is to override `dispatchKeyEvent` in `KioskActivity` and route keys to the pad directly while it is showing.
- [ ] Wrong PIN → "Wrong PIN", dots clear.
- [ ] 5 wrong entries → lockout message; input rejected for 60 s.
- [ ] Correct PIN → Settings opens, player still running behind it.
- [ ] From Settings, BACK returns to the player and it does **not** snap back to kiosk (still unlocked).
- [ ] Leave the pad untouched for 20 s → it disappears on its own.
- [ ] Reboot the box → kiosk is locked again, long-press BACK still opens the pad.
- [ ] Build without `-PKIOSK_PIN`, install, long-press BACK → nothing happens.
- [ ] Repeat the core path on `assembleNativeDebug` (launch `ai.lanka.kiosk.vs/ai.lanka.kiosk.PlayerActivity`).

If `onKeyLongPress` never fires on this ROM, fall back to detecting `event.repeatCount >= 1` inside `onKeyDown` and record the deviation in the README.

- [ ] **Step 3: Update `CLAUDE.md`**

In the "Android kiosk player (APK)" section, add a bullet:

```markdown
- **On-device PIN escape hatch:** long-press BACK opens a native `PinPadView`
  over the player; a correct PIN (sha256-baked via `-PKIOSK_PIN`, empty default
  = disabled) clears `KioskLock`, releases lock task and opens Settings. All of
  it lives in `src/main` so both flavors share one implementation, and the pad is
  a **native view, not HTML** — it must still work when the WebView renderer is
  dead. `KioskLock.locked` is now **listener-driven**: assigning it mirrors into
  real lock-task state via `KioskActivity`, which is what makes the dashboard's
  `kiosk-unlock` command actually work on a pinned box (it previously flipped the
  flag but never called `stopLockTask()`). The listener runs inline on the main
  thread and hops `mainHandler` otherwise, because the dashboard sets the flag
  off-thread and `start/stopLockTask` are main-thread-only.
```

- [ ] **Step 4: Commit**

```bash
cd /home/dmytro/PhpstormProjects/lanka
git add CLAUDE.md
git commit -m "docs(kiosk): record the on-device PIN unlock in the project guide"
```

---

## Self-Review Notes

**Spec coverage:** every spec section maps to a task — `KioskPin` → 1; `KioskLock` listener → 2; `stopKioskMode` + `onResume` guard + threading → 3; PIN storage/hashing/disabled-default → 4; `PinPadView` + auto-dismiss + key routing → 5; trigger + unlock + Settings jump + logging → 6; testing → 1, 2 and Task 7's on-box gate; documentation → 4 and 7.

**Deliberately not implemented** (spec non-goals): per-device PINs, server-delivered PINs, PIN rotation without a rebuild, unlock reporting to the server, automatic re-lock on a timer.

**Type consistency:** `KioskPin.Result` members (`INCOMPLETE`/`UNLOCKED`/`WRONG`/`LOCKED_OUT`) are identical in Tasks 1 and 5. `PinPadView`'s four-argument constructor matches its call site in Task 6. `DevicePolicy.stopKioskMode(Activity)` is defined in Task 3 and called in Task 3 only. `BuildConfig.KIOSK_PIN_SHA256`/`KIOSK_PIN_LENGTH` are produced in Task 4 and consumed in Task 6.

**Known risk carried into execution:** the WebView flavor stealing D-pad keys. Mitigated by `requestFocus()` in Task 5, with an explicit fallback recorded in Task 7 Step 2.
