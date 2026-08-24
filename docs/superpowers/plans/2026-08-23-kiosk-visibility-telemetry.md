# Kiosk Visibility Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report whether the Lanka player is actually on screen — `foreground` / `obscured` / `background`, plus snap-back, focus-loss and hidden-time counters and the intruding package name — and surface it as a badge in the dashboard.

**Architecture:** A pure Kotlin state machine (`KioskVisibility`) is fed by lifecycle hooks `KioskActivity` already has, so it is shared by both player surfaces in the single APK. It reaches the server as five new optional fields on the existing telemetry endpoint, posted on the existing playback events and on a sampling tick that fires on state change with a 30 s heartbeat floor. The server stores the values on `devices` and computes `visibility_since` itself; the dashboard renders an amber chip orthogonal to the existing online/idle/offline pill.

**Tech Stack:** Kotlin (Android SDK 34, minSdk 24, JUnit 4, one APK with a runtime-selectable player surface), TypeScript (Nuxt 4 / Nitro / Zod / Drizzle / better-sqlite3), Vue 3 + Nuxt UI v3, Vitest. No new dependencies in either project.

**Spec:** `docs/superpowers/specs/2026-08-23-kiosk-visibility-telemetry-design.md`

## Global Constraints

- **All Android production code goes in `android/app/src/main/kotlin/ai/lanka/kiosk/`, and all Android tests in `android/app/src/test/kotlin/ai/lanka/kiosk/`.** The `webview`/`native` product flavors and the `src/webview`, `src/native`, `src/testNative` source sets **no longer exist** — the two players were merged into one APK with a runtime-selectable surface (`c22632c`). There is one `applicationId`, `ai.lanka.kiosk`.
- **No new Gradle dependencies and no new npm dependencies.**
- **The APK must build and test green** after every Android task: `cd android && ./gradlew test assembleDebug`. There is no `assembleWebviewDebug`/`assembleNativeDebug` any more, and no per-flavor unit-test tasks.
- **Kotlin test style:** JUnit 4, `import org.junit.Assert.*`, backtick-quoted test method names. Match `android/app/src/test/kotlin/ai/lanka/kiosk/KioskPinTest.kt`.
- **Vitest style:** call the exported `handleXxx` function directly, never the default export. Match `tests/api/devices-telemetry.test.ts`.
- **Debounce is 2 000 ms**, applies only to *leaving* `foreground`, and is scoped to the whole non-foreground **episode** — it does not restart when the state moves between `obscured` and `background`. Returning to `foreground` is reported immediately.
- **The player samples every 2 000 ms and posts on a reportable change, with 30 000 ms as a floor.** The heartbeat alone would miss an occlusion that begins and ends between two beats.
- **Every telemetry post carries visibility**, not just the heartbeat — enrichment happens in one place (`useTelemetry` / `TelemetryClient`), never at the call sites.
- **Counters are never debounced** and are measured since process start.
- **`foregroundPackage` is `null` whenever the reported state is `foreground`.**
- **Wire state names are lowercase:** `foreground`, `obscured`, `background`. `unknown` is a DB default only and is never sent by a client.
- **Every new telemetry field is optional** — an un-upgraded APK must keep working unchanged.
- **Vitest is the gate, not `pnpm typecheck`** (~381 pre-existing vue-tsc errors). Run `pnpm test` and, for UI tasks, `pnpm build`.

### Two stories landed after this plan was first written

Re-read every Android file before editing it, and locate methods by name — never by the line numbers quoted here.

**1. On-device PIN unlock (`60020ab`, `050cb7b`).** `KioskActivity` now also holds a `pinPad` field, `dispatchKeyEvent`/`onKeyLongPress`/`onKeyUp` overrides that route keys to the pad, a `KioskLock.listener` that mirrors the flag into real lock-task state, and an `onPause` override. None of it conflicts with Task 2, which only adds lifecycle hooks and a snap-back counter. `KioskActivity` still has **no `onStart` override** — Task 2 adds the first one.

**2. One APK with a runtime-selectable surface (`c22632c`, `10e37e8`).** This is the structural change:

- The `webview` / `native` product flavors are gone. Everything lives in `src/main`, tests in `src/test`. `PlayerActivity` no longer exists.
- A single `MainActivity : KioskActivity()` hosts exactly one `PlayerSurface` — `WebViewSurface` or `NativeSurface` — chosen at `onCreate` from `SurfaceStore` and switched by the dashboard's `set-surface` command via `SurfaceSwitcher.request(...)` + `recreate()`.
- **`PlayerSurface` carries an ownership rule that this plan must honour:** everything `start()` creates, `stop()` releases, and `stop()` is called from `MainActivity.onDestroy` on every `recreate()`. The sampling tick added in Task 8 is created in `NativeSurface.start()` and therefore **must** be shut down in `NativeSurface.stop()`, or a surface switch leaks a scheduler that keeps posting telemetry.
- `KioskVisibility.shared` is process-wide, so one instance serves both surfaces and survives the `recreate()` of a surface switch — which is what makes the counters meaningful across a switch rather than resetting.
- Both `NativeFSBridge` and `player/TelemetryClient` now live under `src/main`.

---

### Task 1: `KioskVisibility` — pure state machine and counters

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskVisibility.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/KioskVisibilityTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `class KioskVisibility(now: () -> Long = System::currentTimeMillis)` with `enum class State { FOREGROUND, OBSCURED, BACKGROUND }` (each carrying `val wire: String`), `data class Snapshot(val state: State, val snapBacks: Int, val focusLosses: Int, val hiddenMs: Long, val episodeMs: Long, val changeSeq: Int)` with `fun toJson(): String`, the mutators `onStarted()` / `onResumed()` / `onPaused()` / `onStopped()` / `onFocusChanged(hasFocus: Boolean)` / `onSnapBackScheduled()`, the reader `snapshot(): Snapshot`, and `companion object { val shared: KioskVisibility; const val DEBOUNCE_MS = 2_000L; const val HEARTBEAT_MS = 30_000L; fun shouldPost(seq: Int, lastSeq: Int, sinceLastPostMs: Long): Boolean }`. Tasks 2, 7 and 8 all depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/kotlin/ai/lanka/kiosk/KioskVisibilityTest.kt`:

```kotlin
package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Test

class KioskVisibilityTest {

    private class FakeClock(var nowMs: Long = 0L) { fun get(): Long = nowMs }

    /** A visibility that has been brought fully to the foreground, as at boot. */
    private fun live(c: FakeClock): KioskVisibility =
        KioskVisibility(c::get).apply {
            onStarted(); onResumed(); onFocusChanged(true)
        }

    @Test
    fun `starts background so a background launch never claims the screen`() {
        val c = FakeClock()
        assertEquals(KioskVisibility.State.BACKGROUND, KioskVisibility(c::get).snapshot().state)
    }

    @Test
    fun `reaching the foreground is not debounced`() {
        val c = FakeClock()
        assertEquals(KioskVisibility.State.FOREGROUND, live(c).snapshot().state)
    }

    @Test
    fun `focus loss becomes obscured after the debounce`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        c.nowMs = 1_999
        assertEquals(KioskVisibility.State.FOREGROUND, v.snapshot().state)
        c.nowMs = 2_000
        assertEquals(KioskVisibility.State.OBSCURED, v.snapshot().state)
    }

    @Test
    fun `pause without stop becomes obscured — a translucent overlay`() {
        val c = FakeClock()
        val v = live(c)
        v.onPaused()
        c.nowMs = 2_000
        assertEquals(KioskVisibility.State.OBSCURED, v.snapshot().state)
    }

    @Test
    fun `stop becomes background`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 2_000
        assertEquals(KioskVisibility.State.BACKGROUND, v.snapshot().state)
    }

    @Test
    fun `an obscured to background move does not restart the debounce`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        c.nowMs = 1_900
        v.onPaused()
        v.onStopped()
        c.nowMs = 2_000
        // The episode began at 0, so 2000ms of CONTINUOUS hiding qualifies even
        // though the sub-state changed 100ms ago.
        assertEquals(KioskVisibility.State.BACKGROUND, v.snapshot().state)
    }

    @Test
    fun `a snap-back sized excursion never surfaces but is still counted`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        v.onSnapBackScheduled()
        c.nowMs = 400
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        c.nowMs = 500
        val s = v.snapshot()
        assertEquals(KioskVisibility.State.FOREGROUND, s.state)
        assertEquals(1, s.snapBacks)
        assertEquals(400L, s.hiddenMs)
    }

    @Test
    fun `recovery to foreground is not debounced`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 5_000
        assertEquals(KioskVisibility.State.BACKGROUND, v.snapshot().state)
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        assertEquals(KioskVisibility.State.FOREGROUND, v.snapshot().state)
    }

    @Test
    fun `hiddenMs accumulates across obscured and background`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        c.nowMs = 1_000
        v.onStopped()
        c.nowMs = 3_000
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        c.nowMs = 9_000
        assertEquals(3_000L, v.snapshot().hiddenMs)
    }

    @Test
    fun `a backwards clock never decreases hiddenMs`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 5_000
        val before = v.snapshot().hiddenMs
        c.nowMs = 1_000 // NTP correction, routine shortly after boot
        assertEquals(before, v.snapshot().hiddenMs)
    }

    @Test
    fun `episodeMs reports the length of the current hidden stretch only`() {
        val c = FakeClock()
        val v = live(c)
        v.onStopped()
        c.nowMs = 4_000
        assertEquals(4_000L, v.snapshot().episodeMs)
        v.onStarted(); v.onResumed(); v.onFocusChanged(true)
        assertEquals(0L, v.snapshot().episodeMs)
    }

    @Test
    fun `focus losses are counted but regains are not`() {
        val c = FakeClock()
        val v = live(c)
        v.onFocusChanged(false)
        v.onFocusChanged(true)
        v.onFocusChanged(false)
        assertEquals(2, v.snapshot().focusLosses)
    }

    @Test
    fun `changeSeq moves only on a reportable change`() {
        val c = FakeClock()
        val v = live(c)
        val seq0 = v.snapshot().changeSeq
        assertEquals(seq0, v.snapshot().changeSeq)      // idle sampling: no move
        v.onStopped()
        c.nowMs = 1_000
        assertEquals(seq0, v.snapshot().changeSeq)      // still debouncing
        c.nowMs = 2_000
        assertNotEquals(seq0, v.snapshot().changeSeq)   // now reportable
    }

    @Test
    fun `shouldPost fires on a change or once per heartbeat`() {
        assertTrue(KioskVisibility.shouldPost(2, 1, 0))
        assertFalse(KioskVisibility.shouldPost(1, 1, 29_999))
        assertTrue(KioskVisibility.shouldPost(1, 1, 30_000))
    }

    @Test
    fun `toJson emits the bridge contract without a package`() {
        val s = KioskVisibility.Snapshot(
            KioskVisibility.State.BACKGROUND, 3, 2, 1_500, 800, 7
        )
        assertEquals(
            """{"visibility":"background","snapBacks":3,"focusLosses":2,""" +
                """"hiddenMs":1500,"episodeMs":800,"changeSeq":7}""",
            s.toJson()
        )
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*KioskVisibilityTest*'`
(`test` is a lifecycle aggregate and rejects `--tests`; use the concrete task.)
Expected: FAIL — `Unresolved reference: KioskVisibility`.

- [ ] **Step 3: Write the implementation**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/KioskVisibility.kt`:

```kotlin
package ai.lanka.kiosk

/**
 * Process-wide record of whether the player is actually ON SCREEN, and of how
 * hard the kiosk had to fight to keep it there.
 *
 * Three states, because the two ways of losing the screen need different
 * operator responses:
 *   FOREGROUND — started, resumed and focused; genuinely visible.
 *   OBSCURED   — started but paused or unfocused, i.e. a dialog or translucent
 *                overlay is on top. The snap-back watchdog never fires for this
 *                case (no onStop), so the player can sit behind a system prompt
 *                indefinitely.
 *   BACKGROUND — not started; another app owns the screen.
 *
 * Deriving BACKGROUND from onStop alone would be wrong: an Activity stops being
 * resumed at onPause, which a translucent overlay triggers WITHOUT ever calling
 * onStop. Focus loss usually accompanies it, but "usually" is not a contract.
 *
 * Born BACKGROUND with every flag false, so a process launched into the
 * background never claims the screen. That costs nothing on a normal boot:
 * recovery to FOREGROUND is not debounced.
 *
 * Debouncing is ONE-DIRECTIONAL and scoped to the EPISODE — the unbroken stretch
 * of not being foreground. Leaving FOREGROUND is only reported once the episode
 * has lasted [DEBOUNCE_MS], comfortably past the 400 ms snap-back, so the badge
 * never flickers on a blip. The episode clock does NOT restart when the state
 * moves between OBSCURED and BACKGROUND — otherwise a focus loss followed 1.9 s
 * later by an onStop would hide a continuously-covered player for nearly four
 * seconds. Returning to foreground is reported immediately. Counters are never
 * debounced — a snap-back war is exactly what they exist to reveal.
 *
 * Every public method is synchronized: mutators run on the main thread, but
 * snapshot() is called from the WebView's JavaBridge thread (WebView surface)
 * and from the sampling scheduler thread (native surface).
 *
 * Pure Kotlin with an injected clock and no Android imports, so it is
 * JVM-unit-testable — same shape as [KioskPin].
 */
class KioskVisibility(private val now: () -> Long = System::currentTimeMillis) {

    enum class State(val wire: String) {
        FOREGROUND("foreground"),
        OBSCURED("obscured"),
        BACKGROUND("background")
    }

    data class Snapshot(
        val state: State,
        val snapBacks: Int,
        val focusLosses: Int,
        val hiddenMs: Long,
        /** Length of the current non-foreground episode; 0 when foreground.
         *  ForegroundAppProbe sizes its UsageStats query window from this. */
        val episodeMs: Long,
        /** Bumped whenever the REPORTABLE state changes, so the sampling tick can
         *  post on a change without re-deriving one itself. */
        val changeSeq: Int
    ) {
        /**
         * The bridge contract, hand-rolled so the pure core stays
         * dependency-free. Deliberately carries no foregroundPackage: the probe
         * is comparatively expensive and is fetched separately, only when a post
         * is actually going out.
         */
        fun toJson(): String =
            "{\"visibility\":\"${state.wire}\",\"snapBacks\":$snapBacks," +
                "\"focusLosses\":$focusLosses,\"hiddenMs\":$hiddenMs," +
                "\"episodeMs\":$episodeMs,\"changeSeq\":$changeSeq}"
    }

    private var started = false
    private var resumed = false
    private var focused = false

    private var raw = State.BACKGROUND
    /** Start of the current non-foreground episode; null while foreground. */
    private var episodeSince: Long? = now()
    private var stable = State.BACKGROUND
    private var changeSeq = 0

    private var lastAccrualAt = now()

    private var snapBacks = 0
    private var focusLosses = 0
    private var hiddenMs = 0L

    @Synchronized fun onStarted() = mutate { started = true }
    @Synchronized fun onResumed() = mutate { started = true; resumed = true }
    @Synchronized fun onPaused() = mutate { resumed = false }
    @Synchronized fun onStopped() = mutate { started = false; resumed = false }

    @Synchronized
    fun onFocusChanged(hasFocus: Boolean) = mutate {
        if (!hasFocus) focusLosses++
        focused = hasFocus
    }

    /** Called once per departure, after the KioskLock check — an unlocked box
     *  arms no return, and one HOME press must not count twice. */
    @Synchronized
    fun onSnapBackScheduled() {
        snapBacks++
    }

    @Synchronized
    fun snapshot(): Snapshot {
        val t = now()
        accrue(t)
        val episodeStart = episodeSince
        val effective = when {
            raw == State.FOREGROUND -> raw
            episodeStart != null && t - episodeStart >= DEBOUNCE_MS -> raw
            else -> stable
        }
        promote(effective)
        return Snapshot(
            state = effective,
            snapBacks = snapBacks,
            focusLosses = focusLosses,
            hiddenMs = hiddenMs,
            episodeMs = if (episodeStart == null) 0L else (t - episodeStart).coerceAtLeast(0L),
            changeSeq = changeSeq
        )
    }

    /** One timestamp per operation, shared by accrual and recomputation. */
    private inline fun mutate(block: () -> Unit) {
        val t = now()
        accrue(t)
        block()
        recompute(t)
    }

    /**
     * Charges elapsed time to hiddenMs when the RAW state is not foreground.
     * Negative deltas are dropped rather than subtracted: System.currentTimeMillis
     * jumps when NTP corrects the clock, which is routine on these boxes shortly
     * after boot.
     */
    private fun accrue(t: Long) {
        val delta = t - lastAccrualAt
        if (raw != State.FOREGROUND && delta > 0) hiddenMs += delta
        lastAccrualAt = t
    }

    private fun recompute(t: Long) {
        val next = when {
            !started -> State.BACKGROUND
            !resumed || !focused -> State.OBSCURED
            else -> State.FOREGROUND
        }
        if (next == raw) return
        raw = next
        // Episode boundaries only — a move BETWEEN the two hidden states keeps
        // the original episode start, so the debounce is not restarted.
        if (next == State.FOREGROUND) {
            episodeSince = null
            // Recovery is immediately reportable, so promote it HERE rather than
            // waiting for a snapshot(). Leaving it to snapshot() meant a
            // foreground stretch nobody sampled left `stable` holding the old
            // hidden state, which the next debounce window would then report.
            promote(State.FOREGROUND)
        } else if (episodeSince == null) {
            episodeSince = t
        }
    }

    /** Records the reportable state, counting a change so the transport posts. */
    private fun promote(s: State) {
        if (s == stable) return
        stable = s
        changeSeq++
    }

    companion object {
        const val DEBOUNCE_MS = 2_000L
        const val HEARTBEAT_MS = 30_000L

        /** Transport rule, shared by both surfaces and mirrored in TypeScript. */
        fun shouldPost(seq: Int, lastSeq: Int, sinceLastPostMs: Long): Boolean =
            seq != lastSeq || sinceLastPostMs >= HEARTBEAT_MS

        /** The instance the player uses. Tests construct their own with a fake clock. */
        @JvmField
        val shared = KioskVisibility()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd android && ./gradlew test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/KioskVisibility.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/KioskVisibilityTest.kt
git commit -m "feat(kiosk): KioskVisibility — pure on-screen state machine + counters"
```

---

### Task 2: Feed `KioskVisibility` from the `KioskActivity` lifecycle

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`

**Interfaces:**
- Consumes: `KioskVisibility.shared.onStarted()`, `.onResumed()`, `.onPaused()`, `.onStopped()`, `.onFocusChanged(Boolean)`, `.onSnapBackScheduled()` from Task 1.
- Produces: nothing new — after this task `KioskVisibility.shared` holds live truth for whichever surface is active.

There is no unit test here: these are `Activity` lifecycle callbacks and the project has no Robolectric (and the plan forbids new Gradle dependencies). The gate is that the APK compiles and the whole JVM suite stays green; behavior is verified on-box in Task 10.

- [ ] **Step 1: Re-read the file before editing**

Run: `sed -n 1,140p android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`

The PIN-unlock plan is editing this same file in parallel (see "Concurrency warning" above). Locate every method by name, not by line number. Note the file already overrides `onResume`, `onPause`, `onUserLeaveHint`, `onStop`, `onWindowFocusChanged` and `onKeyDown`, and does **not** yet override `onStart`.

- [ ] **Step 2: Add the snap-back pending flag**

`scheduleKioskReturn()` is called from BOTH `onUserLeaveHint()` and `onStop()`, so a single HOME press runs it twice — counting each call would double every snap-back figure. Add the flag as a field next to `mainHandler`:

```kotlin
    /** One departure = one snap-back. scheduleKioskReturn() runs twice per HOME
     *  press (onUserLeaveHint, then onStop); the second call only reposts the
     *  same runnable and must not be counted again. */
    private var kioskReturnPending = false
```

and clear it when the return actually runs, inside the existing `kioskReturnRunnable`, as its first statement:

```kotlin
        kioskReturnPending = false
```

- [ ] **Step 3: Count one snap-back per departure**

Replace `scheduleKioskReturn()`:

```kotlin
    protected fun scheduleKioskReturn() {
        if (!KioskLock.locked) return // unlocked for maintenance — let the user leave
        if (!kioskReturnPending) {
            kioskReturnPending = true
            KioskVisibility.shared.onSnapBackScheduled()
        }
        mainHandler.removeCallbacks(kioskReturnRunnable)
        mainHandler.postDelayed(kioskReturnRunnable, KIOSK_RETURN_MS)
    }
```

Counting after the `KioskLock.locked` guard is deliberate: an unlocked box reports zero snap-backs while an operator walks away, because leaving on purpose is not the kiosk losing a fight.

- [ ] **Step 4: Add the `onStart` hook**

`KioskActivity` has no `onStart` override yet. Add one above `onResume`:

```kotlin
    override fun onStart() {
        super.onStart()
        KioskVisibility.shared.onStarted()
    }
```

- [ ] **Step 5: Add the `onResume` hook and cancel a pending return**

In `onResume()`, immediately after `super.onResume()`:

```kotlin
        KioskVisibility.shared.onResumed()
```

and extend the existing snap-back cancellation at the end of the method so the flag cannot go stale:

```kotlin
        // Cancel a pending snap-back — we're already in front.
        mainHandler.removeCallbacks(kioskReturnRunnable)
        kioskReturnPending = false
```

- [ ] **Step 6: Add the `onPause` hook**

In the existing `onPause()`, immediately after `super.onPause()` and before the `KioskLock.listener` cleanup:

```kotlin
        // onPause, not just onStop: a translucent overlay pauses us without ever
        // stopping us, and that still means we are not the visible surface.
        KioskVisibility.shared.onPaused()
```

- [ ] **Step 7: Add the `onStop` hook**

In `onStop()`, immediately after `super.onStop()` and *before* the existing `if (!isFinishing && !isChangingConfigurations)` line:

```kotlin
        KioskVisibility.shared.onStopped()
```

- [ ] **Step 8: Add the focus hook**

Replace the body of `onWindowFocusChanged` so focus *loss* is recorded too — today only the regain branch does anything:

```kotlin
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Focus loss without onStop means a dialog/overlay is on top — the one
        // kiosk failure the snap-back watchdog can never fix, and until now the
        // one the dashboard could never see.
        KioskVisibility.shared.onFocusChanged(hasFocus)
        if (hasFocus) KioskFlags.apply(this)
    }
```

- [ ] **Step 9: Note what a surface switch does to these hooks**

A `set-surface` command calls `recreate()`, so `MainActivity` is destroyed and rebuilt: `onStop` then `onStart` fire even though nothing left the screen. Two consequences to keep in mind, both verified on-box in Task 10:

- The 2 000 ms debounce means a fast `recreate()` never surfaces a state change — the box does not blink to `background` in the dashboard.
- `scheduleKioskReturn()` is already guarded by `!isFinishing && !isChangingConfigurations`, which is what should keep a deliberate switch from counting as a snap-back. **Verify this rather than assuming it** (Task 10, check 7): if `snapBacks` moves on a surface switch, gate the counter on a `SurfaceSwitcher`-set flag instead of loosening the debounce.

- [ ] **Step 10: Verify the APK builds and the suite is green**

Run: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL, all unit tests pass.

- [ ] **Step 11: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt
git commit -m "feat(kiosk): record on-screen state from the KioskActivity lifecycle"
```

---

### Task 3: `ForegroundAppProbe` — name the app that took the screen

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/ForegroundAppProbe.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/README.md` (the per-box recipe under "Kiosk hardening WITHOUT device owner")

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `object ForegroundAppProbe { fun current(context: Context, episodeMs: Long): String? }` — the package name of the app that most recently came to the foreground, or `null` when that app is us or nothing is known. Tasks 7 and 8 call it.

No unit test: this is a thin wrapper over a platform API with no logic worth isolating, and the project has no Robolectric. It is written to be total — every failure path returns `null`.

- [ ] **Step 1: Write the implementation**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/ForegroundAppProbe.kt`:

```kotlin
package ai.lanka.kiosk

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context

/**
 * Names whatever app is sitting on top of the player.
 *
 * UsageStats is the only source for this on modern Android: getRunningTasks is
 * restricted and getRunningAppProcesses returns only our own process. It needs
 * the PACKAGE_USAGE_STATS appop, granted per box over ADB alongside the appops
 * already in android/README.md:
 *
 *   adb shell appops set ai.lanka.kiosk GET_USAGE_STATS allow
 *
 * Without the grant queryEvents yields nothing and this returns null — the
 * dashboard then says "covered by unknown app" rather than breaking. Every call
 * is guarded, because some ROMs throw here even with the appop set.
 *
 * Sampled ONLY when a post is actually going out and we are not in the
 * foreground — never on the playback hot path and never on the 2 s sampling tick.
 */
object ForegroundAppProbe {

    /** Extra lookback beyond the episode, covering scheduler jitter and doze. */
    private const val SLACK_MS = 15_000L
    /** Never query less than this, so a just-started episode still finds its event. */
    private const val MIN_WINDOW_MS = 30_000L
    /** Never query more than this — a box hidden for days must not scan forever. */
    private const val MAX_WINDOW_MS = 6L * 60 * 60 * 1_000

    /**
     * @param episodeMs how long we have been non-foreground, from
     *   KioskVisibility.Snapshot.episodeMs. The window is derived from it: a
     *   fixed short lookback would miss the covering app entirely, because the
     *   MOVE_TO_FOREGROUND event fires once, when the intruder appears — which
     *   may be long before the post that asks about it.
     */
    fun current(context: Context, episodeMs: Long): String? = runCatching {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return null
        val end = System.currentTimeMillis()
        val window = (episodeMs + SLACK_MS).coerceIn(MIN_WINDOW_MS, MAX_WINDOW_MS)
        val events = usm.queryEvents(end - window, end)
        val event = UsageEvents.Event()
        var latestPkg: String? = null
        var latestTs = Long.MIN_VALUE
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            // MOVE_TO_FOREGROUND and ACTIVITY_RESUMED are the same constant (1);
            // the latter is just its API 29+ name.
            @Suppress("DEPRECATION")
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND &&
                event.packageName != null &&
                event.timeStamp >= latestTs
            ) {
                latestTs = event.timeStamp
                latestPkg = event.packageName
            }
        }
        // Take the most recent resume OVERALL and reject it if it is us. Scanning
        // for the latest non-Lanka event instead would blame a stale, unrelated
        // app whenever Lanka had since resumed, or when an own-app dialog stole
        // focus with no other app involved.
        if (latestPkg == null || latestPkg == context.packageName) null else latestPkg
    }.getOrNull()
}
```

- [ ] **Step 2: Declare the permission**

In `android/app/src/main/AndroidManifest.xml`, alongside the existing `uses-permission` block, add:

```xml
    <uses-permission android:name="android.permission.PACKAGE_USAGE_STATS"
        tools:ignore="ProtectedPermissions"/>
```

The `tools:ignore` needs the tools namespace on the root `<manifest>` element. If `xmlns:tools="http://schemas.android.com/tools"` is not already there, add it.

- [ ] **Step 3: Document the per-box grant**

In `android/README.md`, in the fenced block under "Kiosk hardening WITHOUT device owner (per box)", append a third command:

```bash
# Name the app that covered the player (visibility telemetry); optional —
# without it the dashboard still reports "covered", just not by what.
adb shell appops set ai.lanka.kiosk GET_USAGE_STATS allow
```

One grant covers both player surfaces: since the flavors were merged there is a single `applicationId`, and the surface is a runtime choice inside the same package.

- [ ] **Step 4: Verify the APK builds**

Run: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL, all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/ForegroundAppProbe.kt \
        android/app/src/main/AndroidManifest.xml android/README.md
git commit -m "feat(kiosk): ForegroundAppProbe — name the app covering the player"
```

---

### Task 4: Telemetry contract — schema, migration, handler

**Files:**
- Modify: `server/db/schema.ts` (the `devices` table, after the `surface` column)
- Create: `server/db/migrations/00NN_*.sql` (generated by drizzle-kit — do not hand-write)
- Modify: `server/api/devices/[id]/telemetry.post.ts`
- Test: `tests/api/devices-telemetry.test.ts`

**Interfaces:**
- Consumes: the JSON contract produced by `KioskVisibility.Snapshot.toJson` in Task 1.
- Produces: `devices.visibility` / `.visibilitySince` / `.foregroundPackage` / `.snapBacks` / `.focusLosses` / `.hiddenMs` columns, and a `handleTelemetry` whose `currentItemId` is optional. Tasks 5, 6 and 8 depend on both.

- [ ] **Step 1: Write the failing tests**

Add `vi` to the existing vitest import at the top of `tests/api/devices-telemetry.test.ts`, then append inside the existing `describe` block:

```typescript
  async function device() {
    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    return dev
  }

  it('defaults visibility to unknown before any report', async () => {
    await setup()
    expect((await device()).visibility).toBe('unknown')
  })

  it('persists visibility and counters', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja',
      snapBacks: 7,
      focusLosses: 2,
      hiddenMs: 45_000
    })
    const dev = await device()
    expect(dev.visibility).toBe('background')
    expect(dev.foregroundPackage).toBe('com.netflix.ninja')
    expect(dev.snapBacks).toBe(7)
    expect(dev.focusLosses).toBe(2)
    expect(dev.hiddenMs).toBe(45_000)
  })

  it('a heartbeat without currentItemId does not count a play', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    const [m] = await db.select().from(schema.media).where(eq(schema.media.sha256, 'a'))
    expect(m.playCount).toBe(1)
  })

  it('a heartbeat without currentItemId leaves the current item alone', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    expect((await device()).currentItemId).toBe(item.id)
  })

  it('an explicit null currentItemId still clears', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    expect((await device()).currentItemId).toBeNull()
  })

  it('a heartbeat still refreshes lastSeenAt', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    expect((await device()).lastSeenAt).not.toBeNull()
  })

  it('stamps visibilitySince only when the state actually changes', async () => {
    // Fake timers: three synchronous better-sqlite3 writes can land in the SAME
    // millisecond, so a real clock makes the "it moved" assertion flaky.
    vi.useFakeTimers()
    try {
      await setup()
      vi.setSystemTime(new Date('2026-08-23T10:00:00Z'))
      await handleTelemetry(db, 'dev-1', { visibility: 'background' })
      const first = (await device()).visibilitySince
      expect(first).not.toBeNull()

      vi.setSystemTime(new Date('2026-08-23T10:00:10Z'))
      await handleTelemetry(db, 'dev-1', { visibility: 'background' })
      expect((await device()).visibilitySince?.getTime()).toBe(first?.getTime())

      vi.setSystemTime(new Date('2026-08-23T10:00:20Z'))
      await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
      expect((await device()).visibilitySince?.getTime()).not.toBe(first?.getTime())
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a stored foregroundPackage when the device reports foreground', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja'
    })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    expect((await device()).foregroundPackage).toBeNull()
  })

  it('does not resurrect a previous intruder when a later report has no package', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', {
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja'
    })
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground' })
    await handleTelemetry(db, 'dev-1', { visibility: 'background' })
    expect((await device()).foregroundPackage).toBeNull()
  })

  it('leaves visibility untouched when the field is omitted', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { visibility: 'obscured' })
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    expect((await device()).visibility).toBe('obscured')
  })

  it('accepts a null foregroundPackage', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { visibility: 'foreground', foregroundPackage: null })
    expect((await device()).foregroundPackage).toBeNull()
  })

  it('rejects an unknown visibility value', async () => {
    await setup()
    await expect(
      handleTelemetry(db, 'dev-1', { visibility: 'sideways' })
    ).rejects.toThrow()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/api/devices-telemetry.test.ts`
Expected: FAIL — the new fields do not exist on the schema or the body type.

- [ ] **Step 3: Add the columns to the Drizzle schema**

In `server/db/schema.ts`, inside `devices`, immediately after the `surface` column:

```typescript
  // Is the player actually ON SCREEN? Reported by the APK from the Activity
  // lifecycle: 'foreground' | 'obscured' (a dialog is on top) | 'background'
  // (another app owns the screen). 'unknown' is the pre-report default and is
  // never sent by a client. See specs/2026-08-23-kiosk-visibility-telemetry-design.md
  visibility: text('visibility').notNull().default('unknown'),
  // Stamped server-side, only when the reported visibility differs from the
  // stored one — so "hidden for 4 minutes" is derivable without the device
  // tracking it.
  visibilitySince: integer('visibility_since', { mode: 'timestamp_ms' }),
  // Package that covered the player, when UsageStats is permitted; else null.
  foregroundPackage: text('foreground_package'),
  // Counters since the APK process started — a value going DOWN means the app
  // restarted. The server stores them as reported and never accumulates.
  snapBacks: integer('snap_backs').notNull().default(0),
  focusLosses: integer('focus_losses').notNull().default(0),
  hiddenMs: integer('hidden_ms').notNull().default(0),
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`
Then: `ls server/db/migrations | tail -2 && cat server/db/migrations/$(ls server/db/migrations | grep -E '^00[0-9]+_' | tail -1)`
Expected: a new `00NN_*.sql` containing six `ALTER TABLE devices ADD ...` statements. If drizzle-kit proposes anything else — a table rebuild, a drop — stop and investigate before continuing.

- [ ] **Step 5: Extend the request schema**

In `server/api/devices/[id]/telemetry.post.ts`, replace `BodySchema`:

```typescript
const BodySchema = z.object({
  // Optional, not required-nullable: `undefined` = don't touch and don't count
  // (the 30 s heartbeat), `null` = clear the current item, a number = a real
  // play start. Without this distinction every heartbeat would inflate
  // media.play_count by 120x/hour.
  currentItemId: z.number().int().positive().nullable().optional(),
  apkVersion: z.string().max(50).optional(),
  surface: z.enum(['webview', 'native']).optional(),
  visibility: z.enum(['foreground', 'obscured', 'background']).optional(),
  foregroundPackage: z.string().max(128).nullable().optional(),
  snapBacks: z.number().int().min(0).optional(),
  focusLosses: z.number().int().min(0).optional(),
  hiddenMs: z.number().int().min(0).optional(),
  error: z
    .object({ sha256: z.string().optional(), message: z.string().max(500) })
    .optional()
})
```

- [ ] **Step 6: Make the play-count branch respect optionality**

In the same file, replace `if (body.currentItemId !== null) {` with:

```typescript
  if (body.currentItemId !== undefined && body.currentItemId !== null) {
```

The body of that block is unchanged — it still validates the item and increments `media.play_count` when there is no error.

- [ ] **Step 7: Persist the new fields**

Replace the `db.update(schema.devices)` call with:

```typescript
  const visibilityChanged =
    body.visibility !== undefined && body.visibility !== device.visibility

  await db
    .update(schema.devices)
    .set({
      // Omitted currentItemId means "heartbeat" — leave the current item as is.
      ...(body.currentItemId !== undefined ? { currentItemId: body.currentItemId } : {}),
      lastSeenAt: new Date(),
      ...(body.apkVersion !== undefined ? { apkVersion: body.apkVersion } : {}),
      ...(body.surface !== undefined ? { surface: body.surface } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      ...(visibilityChanged ? { visibilitySince: new Date() } : {}),
      // Coupled to visibility, NOT independently optional. Whenever a state is
      // reported the package column is rewritten: null for foreground, else
      // whatever was reported (null included). Otherwise a previous intruder's
      // name lingers and reappears during a later episode whose probe found
      // nothing.
      ...(body.visibility !== undefined
        ? {
            foregroundPackage:
              body.visibility === 'foreground' ? null : (body.foregroundPackage ?? null)
          }
        : body.foregroundPackage !== undefined
          ? { foregroundPackage: body.foregroundPackage }
          : {}),
      ...(body.snapBacks !== undefined ? { snapBacks: body.snapBacks } : {}),
      ...(body.focusLosses !== undefined ? { focusLosses: body.focusLosses } : {}),
      ...(body.hiddenMs !== undefined ? { hiddenMs: body.hiddenMs } : {})
    })
    .where(eq(schema.devices.id, deviceId))
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run tests/api/devices-telemetry.test.ts`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm test`
Expected: PASS. Any failure here means another caller relied on `currentItemId` being required.

- [ ] **Step 10: Commit**

```bash
git add server/db/schema.ts server/db/migrations server/api/devices/\[id\]/telemetry.post.ts \
        tests/api/devices-telemetry.test.ts
git commit -m "feat(devices): accept visibility + kiosk counters on telemetry"
```

---

### Task 5: Serve visibility from the device APIs

**Files:**
- Modify: `server/api/devices/[id]/status.get.ts`
- Modify: `server/api/devices/index.get.ts`
- Modify: `app/types/api.ts` (`Device` and `DeviceNowPlaying`)
- Test: `tests/api/devices-status.test.ts` (exists) and `tests/api/devices.test.ts` (exists — this is where `handleListDevices` is tested; there is no `devices-list.test.ts`)

**Interfaces:**
- Consumes: the `devices` columns from Task 4.
- Produces: `DeviceNowPlaying` and `DeviceListRow` both carrying `visibility: 'foreground' | 'obscured' | 'background' | 'unknown'`, `visibilitySince: number | null`, `foregroundPackage: string | null`, `snapBacks: number`, `focusLosses: number`, `hiddenMs: number`. Task 9 renders exactly these.

- [ ] **Step 1: Open the two existing test files**

Run: `ls tests/api | grep -i device`
Both target files already exist: put the two `status …` tests in `tests/api/devices-status.test.ts` and the list test in `tests/api/devices.test.ts`. Append to the existing `describe` blocks and reuse their existing fixtures rather than adding new boilerplate.

- [ ] **Step 2: Write the failing tests**

```typescript
  it('status exposes visibility fields', async () => {
    await seedDevice(db, { id: 'dev-1' })
    await handleTelemetry(db, 'dev-1', {
      visibility: 'obscured',
      foregroundPackage: 'com.android.settings',
      snapBacks: 4,
      focusLosses: 1,
      hiddenMs: 9_000
    })
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.visibility).toBe('obscured')
    expect(s.foregroundPackage).toBe('com.android.settings')
    expect(s.snapBacks).toBe(4)
    expect(s.focusLosses).toBe(1)
    expect(s.hiddenMs).toBe(9_000)
    expect(typeof s.visibilitySince).toBe('number')
  })

  it('status reports unknown visibility for a device that never reported', async () => {
    await seedDevice(db, { id: 'dev-2' })
    const s = await handleDeviceStatus(db, 'dev-2')
    expect(s.visibility).toBe('unknown')
    expect(s.visibilitySince).toBeNull()
  })

  it('the device list carries visibility per row', async () => {
    await seedDevice(db, { id: 'dev-1' })
    await handleTelemetry(db, 'dev-1', { visibility: 'background', foregroundPackage: 'com.x' })
    const rows = await handleListDevices(db, {})
    const row = rows.find((r) => r.id === 'dev-1')!
    expect(row.visibility).toBe('background')
    expect(row.foregroundPackage).toBe('com.x')
  })
```

Import `handleDeviceStatus` from `~/server/api/devices/[id]/status.get`, `handleListDevices` from `~/server/api/devices/index.get`, and `handleTelemetry` from `~/server/api/devices/[id]/telemetry.post`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/api/devices-status.test.ts tests/api/devices.test.ts`
Expected: FAIL — the properties do not exist on the returned objects.

- [ ] **Step 4: Extend the status endpoint**

In `server/api/devices/[id]/status.get.ts`, add to the `DeviceStatus` type:

```typescript
  visibility: 'foreground' | 'obscured' | 'background' | 'unknown'
  visibilitySince: number | null
  foregroundPackage: string | null
  snapBacks: number
  focusLosses: number
  hiddenMs: number
```

and to the returned object:

```typescript
    visibility: device.visibility as DeviceStatus['visibility'],
    visibilitySince: device.visibilitySince?.getTime() ?? null,
    foregroundPackage: device.foregroundPackage ?? null,
    snapBacks: device.snapBacks,
    focusLosses: device.focusLosses,
    hiddenMs: device.hiddenMs
```

- [ ] **Step 5: Extend the list endpoint**

In `server/api/devices/index.get.ts`, add to the explicit `.select({...})` projection:

```typescript
        visibility: schema.devices.visibility,
        visibilitySince: schema.devices.visibilitySince,
        foregroundPackage: schema.devices.foregroundPackage,
        snapBacks: schema.devices.snapBacks,
        focusLosses: schema.devices.focusLosses,
        hiddenMs: schema.devices.hiddenMs,
```

- [ ] **Step 6: Extend the client types**

In `app/types/api.ts`, add to `interface Device` (which `DeviceListRow` extends):

```typescript
  visibility: 'foreground' | 'obscured' | 'background' | 'unknown'
  visibilitySince: string | number | null
  foregroundPackage: string | null
  snapBacks: number
  focusLosses: number
  hiddenMs: number
```

and the same six fields to `interface DeviceNowPlaying`, with `visibilitySince: number | null`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/api/devices app/types/api.ts tests/api
git commit -m "feat(devices): expose visibility + counters on status and list APIs"
```

---

### Task 6: `useVisibility`, telemetry enrichment, and the sampling tick

**Files:**
- Create: `app/composables/player/useVisibility.ts`
- Test: `tests/player/useVisibility.test.ts`
- Modify: `app/composables/player/useTelemetry.ts`
- Test: `tests/player/useTelemetry.test.ts` (exists — append to its existing `describe` block)
- Modify: `app/composables/useApiClient.ts` (the `postTelemetry` body type)
- Modify: `app/composables/player/usePlayerBoot.ts`

**Interfaces:**
- Consumes: `NativeFS.visibility(): string` and `NativeFS.foregroundPackage(episodeMs: number): string` (added in Task 7 — this task must tolerate their absence), and the server contract from Task 4.
- Produces: `VisibilitySnapshot { visibility; foregroundPackage; snapBacks; focusLosses; hiddenMs; episodeMs; changeSeq }`, `createVisibility(deps?): VisibilityHandle` with `snapshot(): VisibilitySnapshot` and `stop()`, `shouldPost(seq, lastSeq, sinceLastPostMs): boolean`, and a `useTelemetry(api, visibility?)` that enriches every post.

- [ ] **Step 1: Write the failing test**

Create `tests/player/useVisibility.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createVisibility, shouldPost } from '~/app/composables/player/useVisibility'

describe('createVisibility', () => {
  function bridge(state: string, extra: Record<string, unknown> = {}) {
    return {
      visibility: () =>
        JSON.stringify({
          visibility: state,
          snapBacks: 3,
          focusLosses: 1,
          hiddenMs: 1234,
          episodeMs: 5000,
          changeSeq: 7,
          ...extra
        }),
      foregroundPackage: (_ms: number) => 'com.netflix.ninja'
    }
  }

  it('prefers the NativeFS bridge when present', () => {
    const v = createVisibility({ nativeFS: bridge('background') as any })
    expect(v.snapshot()).toEqual({
      visibility: 'background',
      foregroundPackage: 'com.netflix.ninja',
      snapBacks: 3,
      focusLosses: 1,
      hiddenMs: 1234,
      episodeMs: 5000,
      changeSeq: 7
    })
  })

  it('does not probe for a package while in the foreground', () => {
    const b = bridge('foreground')
    const spy = vi.spyOn(b, 'foregroundPackage')
    const v = createVisibility({ nativeFS: b as any })
    expect(v.snapshot().foregroundPackage).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats an empty package string as null', () => {
    const b = { ...bridge('background'), foregroundPackage: () => '' }
    expect(createVisibility({ nativeFS: b as any }).snapshot().foregroundPackage).toBeNull()
  })

  it('falls back to foreground when the bridge returns garbage', () => {
    const v = createVisibility({ nativeFS: { visibility: () => 'not json' } as any })
    expect(v.snapshot().visibility).toBe('foreground')
  })

  it('uses the Page Visibility API with no bridge', () => {
    let hidden = false
    const listeners: Array<() => void> = []
    const doc = {
      get hidden() { return hidden },
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: vi.fn()
    }
    let now = 0
    const v = createVisibility({ doc: doc as any, now: () => now })
    expect(v.snapshot().visibility).toBe('foreground')
    const seq0 = v.snapshot().changeSeq

    hidden = true
    listeners.forEach((cb) => cb())
    now = 5_000
    const s = v.snapshot()
    expect(s.visibility).toBe('background')
    expect(s.focusLosses).toBe(1)
    expect(s.hiddenMs).toBe(5_000)
    expect(s.foregroundPackage).toBeNull()
    expect(s.changeSeq).not.toBe(seq0)
  })

  it('never reports obscured from the browser fallback', () => {
    const doc = { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const v = createVisibility({ doc: doc as any, now: () => 0 })
    expect(v.snapshot().visibility).not.toBe('obscured')
  })

  it('stop() detaches the listener', () => {
    const doc = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const v = createVisibility({ doc: doc as any, now: () => 0 })
    v.stop()
    expect(doc.removeEventListener).toHaveBeenCalled()
  })
})

describe('shouldPost', () => {
  it('fires on a change or once per heartbeat', () => {
    expect(shouldPost(2, 1, 0)).toBe(true)
    expect(shouldPost(1, 1, 29_999)).toBe(false)
    expect(shouldPost(1, 1, 30_000)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/player/useVisibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the composable**

Create `app/composables/player/useVisibility.ts`:

```typescript
// app/composables/player/useVisibility.ts
//
// Is the player actually on screen? Two sources, in order of trust:
//
//  1. NativeFS — the APK's Activity lifecycle. Authoritative, and the only
//     source that can distinguish `obscured` (a dialog on top, which the
//     snap-back watchdog never fixes) from `background`. Split across two bridge
//     calls on purpose: visibility() is nearly free and safe to call on the 2 s
//     tick, while foregroundPackage() runs a UsageStats query and is called only
//     when a post is going out and we are not in the foreground.
//  2. The Page Visibility API — a plain browser. Reports foreground/background
//     only; document.visibilityState does not change when a dialog is drawn
//     over the app, so `obscured` is unreachable here by construction.

export interface VisibilitySnapshot {
  visibility: 'foreground' | 'obscured' | 'background'
  foregroundPackage: string | null
  snapBacks: number
  focusLosses: number
  hiddenMs: number
  /** Length of the current non-foreground episode; 0 when foreground. */
  episodeMs: number
  /** Bumped whenever the reportable state changes. */
  changeSeq: number
}

export interface VisibilityDeps {
  nativeFS?: { visibility?: () => string; foregroundPackage?: (episodeMs: number) => string }
  /** Injected in tests; defaults to globalThis.document. */
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
  /** Injected in tests; defaults to Date.now. */
  now?: () => number
}

export interface VisibilityHandle {
  snapshot(): VisibilitySnapshot
  stop(): void
}

/** Post when the reportable state moved, or once per heartbeat interval.
 *  Mirrors KioskVisibility.shouldPost in Kotlin — keep the two in step. */
export const HEARTBEAT_MS = 30_000

export function shouldPost(seq: number, lastSeq: number, sinceLastPostMs: number): boolean {
  return seq !== lastSeq || sinceLastPostMs >= HEARTBEAT_MS
}

const FOREGROUND: VisibilitySnapshot = {
  visibility: 'foreground',
  foregroundPackage: null,
  snapBacks: 0,
  focusLosses: 0,
  hiddenMs: 0,
  episodeMs: 0,
  changeSeq: 0
}

export function createVisibility(deps: VisibilityDeps = {}): VisibilityHandle {
  const readState = deps.nativeFS?.visibility

  if (readState) {
    const readPackage = deps.nativeFS?.foregroundPackage
    return {
      snapshot(): VisibilitySnapshot {
        try {
          const p = JSON.parse(readState())
          // Trust the shape only as far as the enum — a bridge returning
          // anything unexpected must not poison the dashboard.
          if (
            p?.visibility === 'foreground' ||
            p?.visibility === 'obscured' ||
            p?.visibility === 'background'
          ) {
            const episodeMs = Number(p.episodeMs ?? 0)
            let pkg: string | null = null
            if (p.visibility !== 'foreground' && readPackage) {
              try {
                pkg = readPackage(episodeMs) || null
              } catch {
                pkg = null
              }
            }
            return {
              visibility: p.visibility,
              foregroundPackage: pkg,
              snapBacks: Number(p.snapBacks ?? 0),
              focusLosses: Number(p.focusLosses ?? 0),
              hiddenMs: Number(p.hiddenMs ?? 0),
              episodeMs,
              changeSeq: Number(p.changeSeq ?? 0)
            }
          }
        } catch {
          /* fall through */
        }
        return { ...FOREGROUND }
      },
      stop() { /* nothing to detach */ }
    }
  }

  const doc = deps.doc ?? (globalThis as any).document
  const now = deps.now ?? Date.now
  if (!doc) {
    return { snapshot: () => ({ ...FOREGROUND }), stop() {} }
  }

  let focusLosses = 0
  let hiddenMs = 0
  let changeSeq = 0
  let lastReported: 'foreground' | 'background' = doc.hidden ? 'background' : 'foreground'
  let hiddenSince: number | null = doc.hidden ? now() : null

  function accrue(): void {
    if (hiddenSince !== null) {
      const t = now()
      const delta = t - hiddenSince
      if (delta > 0) hiddenMs += delta
      hiddenSince = t
    }
  }

  const onChange = (): void => {
    accrue()
    if (doc.hidden) {
      if (hiddenSince === null) {
        hiddenSince = now()
        focusLosses++
      }
    } else {
      hiddenSince = null
    }
  }
  doc.addEventListener('visibilitychange', onChange)

  return {
    snapshot(): VisibilitySnapshot {
      accrue()
      const state: 'foreground' | 'background' = doc.hidden ? 'background' : 'foreground'
      if (state !== lastReported) {
        lastReported = state
        changeSeq++
      }
      return {
        visibility: state,
        foregroundPackage: null,
        snapBacks: 0,
        focusLosses,
        hiddenMs,
        episodeMs: hiddenSince === null ? 0 : Math.max(0, now() - hiddenSince),
        changeSeq
      }
    },
    stop() {
      doc.removeEventListener('visibilitychange', onChange)
    }
  }
}
```

Note the browser fallback deliberately has no debounce: `document.hidden` does not flip for a 400 ms snap-back (there is no APK doing snap-backs in a browser), so there is nothing to suppress.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/player/useVisibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen the API client body type**

In `app/composables/useApiClient.ts`, replace the `postTelemetry` body type with:

```typescript
    body: {
      currentItemId?: number | null
      apkVersion?: string
      visibility?: 'foreground' | 'obscured' | 'background'
      foregroundPackage?: string | null
      snapBacks?: number
      focusLosses?: number
      hiddenMs?: number
      error?: { sha256?: string; message: string }
    }
```

- [ ] **Step 6: Write the failing telemetry-enrichment test**

In `tests/player/useTelemetry.test.ts`, add:

```typescript
  it('enriches every post with visibility, not just the heartbeat', async () => {
    const posts: any[] = []
    const api = { postTelemetry: (_id: string, body: any) => { posts.push(body); return Promise.resolve() } }
    const vis = {
      snapshot: () => ({
        visibility: 'obscured' as const,
        foregroundPackage: 'com.android.settings',
        snapBacks: 2,
        focusLosses: 5,
        hiddenMs: 900,
        episodeMs: 900,
        changeSeq: 1
      }),
      stop() {}
    }
    const t = useTelemetry(api as any, vis)
    t.itemStarted('dev-1', 42)
    t.itemFailed('dev-1', 42, 'sha', 'decode failed')
    t.clearedCurrent('dev-1')
    t.heartbeat('dev-1')
    expect(posts).toHaveLength(4)
    for (const p of posts) {
      expect(p.visibility).toBe('obscured')
      expect(p.foregroundPackage).toBe('com.android.settings')
      expect(p.snapBacks).toBe(2)
    }
    expect(posts[0].currentItemId).toBe(42)
    expect(posts[2].currentItemId).toBeNull()
    // The heartbeat must omit the field entirely — the server reads an absent
    // currentItemId as "don't touch, don't count".
    expect('currentItemId' in posts[3]).toBe(false)
  })

  it('works without a visibility handle', () => {
    const posts: any[] = []
    const api = { postTelemetry: (_id: string, body: any) => { posts.push(body); return Promise.resolve() } }
    useTelemetry(api as any).itemStarted('dev-1', 1)
    expect(posts[0].visibility).toBeUndefined()
  })
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run tests/player/useTelemetry.test.ts`
Expected: FAIL — `useTelemetry` takes one argument and has no `heartbeat`.

- [ ] **Step 8: Enrich every post in one place**

Rewrite `app/composables/player/useTelemetry.ts`:

```typescript
// app/composables/player/useTelemetry.ts
import type { ApiClient } from '~/app/composables/useApiClient'
import type { VisibilityHandle } from './useVisibility'

export interface Telemetry {
  itemStarted(deviceId: string, currentItemId: number): void
  itemFailed(
    deviceId: string,
    currentItemId: number | null,
    sha256: string | undefined,
    message: string
  ): void
  clearedCurrent(deviceId: string): void
  /** Periodic proof-of-life carrying on-screen state. Sends NO currentItemId,
   *  so the server neither counts a play nor disturbs the current item. */
  heartbeat(deviceId: string): void
}

/**
 * Fire-and-forget telemetry. Each call returns synchronously; the POST
 * runs in the background. Failures are swallowed after a console.warn
 * because the player must keep playing even if telemetry is unreachable.
 *
 * Visibility is attached HERE, to every post, rather than being threaded
 * through each call site — so a state change is reflected at the next play
 * start without waiting for the heartbeat, and no future caller can forget it.
 */
export function useTelemetry(api: ApiClient, visibility?: VisibilityHandle): Telemetry {
  function fire(
    deviceId: string,
    body: {
      currentItemId?: number | null
      error?: { sha256?: string; message: string }
    }
  ): void {
    const nfs = (globalThis as any).NativeFS
    const apkVersion: string | undefined = nfs?.getAppVersion?.()
    const vis = visibility?.snapshot()
    api
      .postTelemetry(deviceId, {
        ...body,
        ...(apkVersion ? { apkVersion } : {}),
        ...(vis
          ? {
              visibility: vis.visibility,
              foregroundPackage: vis.foregroundPackage,
              snapBacks: vis.snapBacks,
              focusLosses: vis.focusLosses,
              hiddenMs: vis.hiddenMs
            }
          : {})
      })
      .catch((err) => {
        console.warn('[player] telemetry post failed', err)
      })
  }
  return {
    itemStarted(deviceId, currentItemId) {
      fire(deviceId, { currentItemId })
    },
    itemFailed(deviceId, currentItemId, sha256, message) {
      fire(deviceId, { currentItemId, error: { sha256, message } })
    },
    clearedCurrent(deviceId) {
      fire(deviceId, { currentItemId: null })
    },
    heartbeat(deviceId) {
      fire(deviceId, {})
    }
  }
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `pnpm vitest run tests/player/useTelemetry.test.ts`
Expected: PASS.

- [ ] **Step 10: Wire the sampling tick into the player**

In `app/composables/player/usePlayerBoot.ts`:

Add the import next to the other player composable imports:

```typescript
import { createVisibility, shouldPost, type VisibilityHandle } from './useVisibility'
```

Declare the state beside `reconciler` and `channel`:

```typescript
  let visibility: VisibilityHandle | null = null
  let sampleTimer: number | null = null
  // boot() is async but onBeforeUnmount is registered synchronously; without
  // this flag an unmount during an await leaves resources created afterwards
  // running forever.
  let disposed = false
```

The visibility handle must exist **before** the first reconcile so the very first play start is already enriched, and `useTelemetry` must receive it. Replace the `const telemetry = useTelemetry(api)` line near the top of `usePlayerBoot` with:

```typescript
  const visibilityHandle = createVisibility({
    nativeFS: (globalThis as any).NativeFS
  })
  visibility = visibilityHandle
  const telemetry = useTelemetry(api, visibilityHandle)
```

(Declare `let visibility: VisibilityHandle | null = null` above that line so the assignment compiles.)

At the end of `boot()`, after `channel.open()`:

```typescript
    if (disposed) return
    let lastSeq = -1
    let lastPostAt = 0
    // Sample cheaply and post on a real change, with the heartbeat as a floor.
    // A 30 s beat alone would miss an occlusion that starts and ends between
    // two beats: the state is only promoted inside snapshot().
    sampleTimer = window.setInterval(() => {
      if (!visibility) return
      const snap = visibility.snapshot()
      const elapsed = Date.now() - lastPostAt
      if (!shouldPost(snap.changeSeq, lastSeq, elapsed)) return
      lastSeq = snap.changeSeq
      lastPostAt = Date.now()
      telemetry.heartbeat(deviceId.value)
    }, 2_000)
```

And in the existing `onBeforeUnmount` teardown block:

```typescript
    disposed = true
    if (sampleTimer !== null) {
      window.clearInterval(sampleTimer)
      sampleTimer = null
    }
    visibility?.stop()
    visibility = null
```

- [ ] **Step 11: Run the full suite and a production build**

Run: `pnpm test && pnpm build`
Expected: PASS and BUILD SUCCESSFUL.

- [ ] **Step 12: Commit**

```bash
git add app/composables/player/useVisibility.ts app/composables/player/useTelemetry.ts \
        app/composables/player/usePlayerBoot.ts app/composables/useApiClient.ts \
        tests/player
git commit -m "feat(player): report on-screen visibility on every telemetry post"
```

---

### Task 7: Expose visibility over the WebView bridge

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt` (moved out of the deleted `src/webview` source set when the APKs merged)

**Interfaces:**
- Consumes: `KioskVisibility.shared.snapshot()` (Task 1), `ForegroundAppProbe.current(context, episodeMs)` (Task 3).
- Produces: `NativeFS.visibility(): String` and `NativeFS.foregroundPackage(episodeMs: Int): String` — the two calls `createVisibility` (Task 6) makes.

Two methods, not one, because their costs differ by orders of magnitude: `visibility()` reads an in-process object and is called every 2 s, while `foregroundPackage()` runs a UsageStats query and is called at most once per post.

The bridge is only reachable while `WebViewSurface` is the active surface — that is fine and needs no guard: when `NativeSurface` is active there is no WebView and no web player, and Task 8 supplies the same data directly from Kotlin.

- [ ] **Step 1: Add the bridge methods**

In `android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt`, after `getAppVersion()`:

```kotlin
    /**
     * Current on-screen state plus kiosk counters, as the JSON the player's
     * useVisibility composable expects. Cheap by design — no UsageStats query —
     * because the player calls this on a 2 s sampling tick.
     *
     * Privileged-origin gated like the other data-returning methods.
     */
    @JavascriptInterface
    fun visibility(): String {
        if (!privilegedOriginAllowed()) return ""
        return KioskVisibility.shared.snapshot().toJson()
    }

    /**
     * The package covering the player, or "" when unknown (appop not granted,
     * ROM refused, or the most recent resume was our own). Separate from
     * [visibility] because this one runs a UsageStats query: the player calls it
     * only when a post is going out and the state is not foreground.
     *
     * @param episodeMs how long we have been hidden, so the probe can size its
     *   lookback window — a fixed short window misses the covering app entirely.
     */
    @JavascriptInterface
    fun foregroundPackage(episodeMs: Int): String {
        if (!privilegedOriginAllowed()) return ""
        return ForegroundAppProbe.current(context, episodeMs.toLong().coerceAtLeast(0L)) ?: ""
    }
```

`Int` rather than `Long` for the parameter: `@JavascriptInterface` marshals JS numbers to `int` most reliably across WebView versions, and the composable already passes a value derived from `episodeMs`.

- [ ] **Step 2: Verify the empty-string refusals are safe on the JS side**

Re-read Step 3 of Task 6: the bridge branch of `createVisibility` wraps `JSON.parse` in `try/catch` and returns the `foreground` default on failure, so `""` from `visibility()` degrades rather than throwing; and `readPackage(...) || null` turns `""` into `null`. Confirm both are present before continuing.

- [ ] **Step 3: Verify the APK builds and the suite is green**

Run: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL, all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt
git commit -m "feat(kiosk): expose visibility + intruder package to the web player"
```

---

### Task 8: `NativeSurface` enrichment and sampling tick

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/TelemetryClient.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/player/TelemetryClientTest.kt` — **this file already exists** with a `CapturingPoster` helper and a `TelemetryClientTest` class. Add the new tests as methods **inside the existing class** and reuse `CapturingPoster`; do not paste a second class or a second package declaration, which would not compile.

**Interfaces:**
- Consumes: `KioskVisibility.shared.snapshot()` (Task 1), `ForegroundAppProbe.current(context, episodeMs)` (Task 3), the server contract (Task 4).
- Produces: `TelemetryClient(poster, apkVersion, surface = "native", visibility: (() -> Pair<KioskVisibility.Snapshot, String?>)? = null)` and `TelemetryClient.heartbeat(deviceId: String)`.

`PlayerActivity` no longer exists: since the APKs merged, the native player is `NativeSurface : PlayerSurface`, hosted by `MainActivity`. **Honour the `PlayerSurface` ownership rule** — everything `start()` creates, `stop()` releases — or the scheduler added here survives a `set-surface` switch and keeps posting telemetry from a dead surface.

- [ ] **Step 1: Write the failing tests**

Add these methods inside the **existing** `class TelemetryClientTest` in `android/app/src/test/kotlin/ai/lanka/kiosk/player/TelemetryClientTest.kt`, and add the import `import ai.lanka.kiosk.KioskVisibility` at the top:

```kotlin
    private fun vis(
        state: KioskVisibility.State = KioskVisibility.State.BACKGROUND,
        pkg: String? = "com.netflix.ninja"
    ): () -> Pair<KioskVisibility.Snapshot, String?> = {
        KioskVisibility.Snapshot(state, 5, 2, 900, 900, 3) to pkg
    }

    @Test fun `heartbeat carries visibility and omits currentItemId`() {
        val p = CapturingPoster()
        TelemetryClient(p, "1.0.0", visibility = vis()).heartbeat("dev")
        val body = p.bodies.single().second
        assertTrue("a heartbeat must not send currentItemId", !body.contains("currentItemId"))
        assertTrue(body.contains("\"visibility\":\"background\""))
        assertTrue(body.contains("\"foregroundPackage\":\"com.netflix.ninja\""))
        assertTrue(body.contains("\"snapBacks\":5"))
        assertTrue(body.contains("\"focusLosses\":2"))
        assertTrue(body.contains("\"hiddenMs\":900"))
        assertTrue(body.contains("\"surface\":\"native\""))
    }

    @Test fun `every event post carries visibility too`() {
        val p = CapturingPoster()
        val t = TelemetryClient(p, "1.0.0", visibility = vis())
        t.itemStarted("dev", 42)
        t.itemFailed("dev", 42, "sha", "decode")
        t.clearedCurrent("dev")
        assertEquals(3, p.bodies.size)
        p.bodies.forEach { assertTrue(it.second.contains("\"visibility\":\"background\"")) }
        assertTrue(p.bodies[0].second.contains("\"currentItemId\":42"))
    }

    @Test fun `a null package is emitted as JSON null`() {
        val p = CapturingPoster()
        TelemetryClient(p, "1.0.0", visibility = vis(KioskVisibility.State.FOREGROUND, null))
            .heartbeat("dev")
        assertTrue(p.bodies.single().second.contains("\"foregroundPackage\":null"))
    }

    @Test fun `without a visibility supplier the body is unchanged`() {
        val p = CapturingPoster()
        TelemetryClient(p, "1.0.0").itemStarted("dev", 42)
        val body = p.bodies.single().second
        assertTrue(!body.contains("visibility"))
        assertTrue(body.contains("\"currentItemId\":42"))
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*TelemetryClientTest*'`
Expected: FAIL — `TelemetryClient` has no `visibility` parameter and no `heartbeat`.

- [ ] **Step 3: Enrich every post in `TelemetryClient`**

In `android/app/src/main/kotlin/ai/lanka/kiosk/player/TelemetryClient.kt`, add the import `import ai.lanka.kiosk.KioskVisibility`, add the constructor parameter, and attach visibility inside the shared `body()` builder so no call site can forget it:

```kotlin
class TelemetryClient(
    private val poster: TelemetryPoster,
    private val apkVersion: String,
    private val surface: String = "native",
    /** Supplies the current on-screen state and the covering package, if any.
     *  Null in tests and on any build that does not report visibility. */
    private val visibility: (() -> Pair<KioskVisibility.Snapshot, String?>)? = null
) {
    private fun JsonObjectBuilder.putVisibility() {
        val (snap, pkg) = visibility?.invoke() ?: return
        put("visibility", snap.state.wire)
        put("foregroundPackage", pkg?.let { JsonPrimitive(it) } ?: JsonNull)
        put("snapBacks", snap.snapBacks)
        put("focusLosses", snap.focusLosses)
        put("hiddenMs", snap.hiddenMs)
    }

    private fun body(currentItemId: Int?, error: Pair<String?, String>? = null): String = buildJsonObject {
        put("currentItemId", currentItemId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("apkVersion", apkVersion)
        put("surface", surface)
        putVisibility()
        if (error != null) putJsonObject("error") {
            error.first?.let { put("sha256", it) }
            put("message", error.second)
        }
    }.toString()

    /**
     * Periodic proof-of-life carrying on-screen state. Deliberately omits
     * currentItemId — the server reads an absent field as "don't touch, don't
     * count", so sampling can never inflate media.play_count.
     */
    fun heartbeat(deviceId: String) = poster.post(
        deviceId,
        buildJsonObject {
            put("apkVersion", apkVersion)
            put("surface", surface)
            putVisibility()
        }.toString()
    )

    fun itemStarted(deviceId: String, currentItemId: Int) = poster.post(deviceId, body(currentItemId))
    fun itemFailed(deviceId: String, currentItemId: Int?, sha256: String?, message: String) =
        poster.post(deviceId, body(currentItemId, sha256 to message))
    fun clearedCurrent(deviceId: String) = poster.post(deviceId, body(null))
}
```

`JsonObjectBuilder` comes from the existing `kotlinx.serialization.json.*` import already at the top of the file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd android && ./gradlew testDebugUnitTest --tests '*TelemetryClientTest*'`
Expected: PASS, including the three pre-existing tests in the class.

- [ ] **Step 5: Supply visibility when `NativeSurface` builds its client**

In `android/app/src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt`, add the imports:

```kotlin
import java.util.concurrent.TimeUnit
```

(`ForegroundAppProbe` and `KioskVisibility` are in the same package — no import needed.)

Replace the existing `telemetry = TelemetryClient(...)` construction inside `start()` with:

```kotlin
        telemetry = TelemetryClient(
            OkHttpTelemetryPoster(http, BuildConfig.LANKA_SERVER_URL),
            BuildConfig.VERSION_NAME,
            visibility = {
                val snap = KioskVisibility.shared.snapshot()
                val pkg = if (snap.state == KioskVisibility.State.FOREGROUND) null
                else ForegroundAppProbe.current(activity, snap.episodeMs)
                snap to pkg
            }
        )
```

`activity` is the `PlayerSurface`'s host, already a constructor property of `NativeSurface`.

- [ ] **Step 6: Add the sampling tick, owned by the surface**

Declare the scheduler beside the existing `bootIo` executor, mirroring its daemon-thread pattern:

```kotlin
    // Owned by this surface: created in start(), shut down in stop(). A leaked
    // scheduler would keep posting telemetry after a set-surface switch.
    private val visibilityExec = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "visibility-sample").apply { isDaemon = true }
    }
```

Start it at the end of `start()`, after `commandClient` is opened:

```kotlin
        // Sample cheaply and post on a real change, with the heartbeat as a
        // floor. A 30 s beat alone would miss an occlusion that starts and ends
        // between two beats. runCatching matters: an uncaught throw inside
        // scheduleWithFixedDelay silently cancels all future runs.
        var lastSeq = -1
        var lastPostAt = 0L
        visibilityExec.scheduleWithFixedDelay({
            runCatching {
                if (stopped) return@runCatching
                val seq = KioskVisibility.shared.snapshot().changeSeq
                val elapsed = System.currentTimeMillis() - lastPostAt
                if (KioskVisibility.shouldPost(seq, lastSeq, elapsed)) {
                    lastSeq = seq
                    lastPostAt = System.currentTimeMillis()
                    telemetry.heartbeat(deviceId)
                }
            }
        }, 2, 2, TimeUnit.SECONDS)
```

The `stopped` check is the same guard the rest of `NativeSurface` uses for callbacks that can land after teardown.

- [ ] **Step 7: Release it in `stop()`**

In `NativeSurface.stop()`, next to `bootIo.shutdownNow()`:

```kotlin
        visibilityExec.shutdownNow()
```

Shut it down **before** the OkHttp dispatcher shutdown that follows, so a tick in flight cannot enqueue a call onto a closing client.

- [ ] **Step 8: Verify the APK builds and the suite is green**

Run: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL, all unit tests pass.

- [ ] **Step 9: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/player/TelemetryClient.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/player/TelemetryClientTest.kt
git commit -m "feat(kiosk): visibility enrichment and sampling tick on the native surface"
```

---

### Task 9: Dashboard — occlusion badge and kiosk-integrity counters

**Files:**
- Create: `app/components/VisibilityBadge.vue`
- Modify: `app/pages/devices/index.vue` (status cell of the row)
- Modify: `app/pages/devices/[id].vue` (next to the Native/WebView badge, ~line 348)
- Modify: `i18n/locales/en.json`, `i18n/locales/uk.json`

**Interfaces:**
- Consumes: `DeviceListRow` and `DeviceNowPlaying` from Task 5.
- Produces: `<VisibilityBadge :visibility="…" :foreground-package="…" :online="…" />`.

Components under `app/components/` are auto-imported — no import statement in the pages.

- [ ] **Step 1: Add the i18n keys**

In `i18n/locales/en.json`, inside the `devices` object:

```json
    "notOnScreen": "Not on screen",
    "coveredBy": "Covered by {app}",
    "dialogOnTop": "Dialog on top",
    "unknownApp": "unknown app",
    "kioskIntegrity": "Kiosk integrity",
    "snapBacks": "Snap-backs",
    "focusLosses": "Focus losses",
    "hiddenTime": "Hidden",
    "sinceAppStart": "since app start",
    "hiddenFor": "Hidden for {duration}",
```

In `i18n/locales/uk.json`, the same keys:

```json
    "notOnScreen": "Не на екрані",
    "coveredBy": "Перекрито застосунком {app}",
    "dialogOnTop": "Діалог поверх плеєра",
    "unknownApp": "невідомий застосунок",
    "kioskIntegrity": "Цілісність кіоску",
    "snapBacks": "Повернень у фокус",
    "focusLosses": "Втрат фокуса",
    "hiddenTime": "Приховано",
    "sinceAppStart": "від старту застосунку",
    "hiddenFor": "Приховано вже {duration}",
```

- [ ] **Step 2: Write the badge component**

Create `app/components/VisibilityBadge.vue`:

```vue
<script setup lang="ts">
// Occlusion is deliberately NOT a status tier: a covered device is perfectly
// online, and collapsing the two facts into one pill would destroy information.
// Rendered only while the device is online — otherwise a box that died
// mid-occlusion would advertise "covered" forever, which is worse than silence.
const props = defineProps<{
  visibility: 'foreground' | 'obscured' | 'background' | 'unknown'
  foregroundPackage?: string | null
  online: boolean
}>()

const { t } = useI18n()

const show = computed(
  () => props.online && (props.visibility === 'obscured' || props.visibility === 'background')
)

const label = computed(() => {
  if (props.visibility === 'obscured') return t('devices.dialogOnTop')
  if (props.foregroundPackage) return t('devices.coveredBy', { app: props.foregroundPackage })
  return t('devices.notOnScreen')
})
</script>

<template>
  <UBadge v-if="show" color="warning" variant="subtle" size="sm" icon="i-lucide-eye-off">
    {{ label }}
  </UBadge>
</template>
```

- [ ] **Step 3: Add the badge to the device list**

In `app/pages/devices/index.vue`, replace the status cell:

```vue
            <td class="px-4 py-3">
              <div class="flex flex-wrap items-center gap-2">
                <StatusDot :status="d.status" label />
                <VisibilityBadge
                  :visibility="d.visibility"
                  :foreground-package="d.foregroundPackage"
                  :online="d.status === 'online'"
                />
              </div>
            </td>
```

- [ ] **Step 4: Add the badge and counters to the device detail page**

In `app/pages/devices/[id].vue`, immediately after the existing Native/WebView `<UBadge>` block:

```vue
            <VisibilityBadge
              :visibility="status?.visibility ?? 'unknown'"
              :foreground-package="status?.foregroundPackage"
              :online="status?.online ?? false"
            />
```

And below that row, the current-episode duration and the cumulative counters. These answer different questions and must not be conflated: `hiddenFor` is how long **this** occlusion has lasted, `hiddenTime` is the total since the app started.

```vue
          <p
            v-if="status && status.online && status.visibility !== 'foreground'
              && status.visibility !== 'unknown' && status.visibilitySince"
            class="mt-2 text-xs text-warning"
          >
            {{ $t('devices.hiddenFor', { duration: fmtDuration(Date.now() - status.visibilitySince) }) }}
          </p>
          <p v-if="status" class="mt-2 text-xs text-(--ui-text-dimmed)">
            {{ $t('devices.kioskIntegrity') }}:
            {{ $t('devices.snapBacks') }} {{ status.snapBacks }} ·
            {{ $t('devices.focusLosses') }} {{ status.focusLosses }} ·
            {{ $t('devices.hiddenTime') }} {{ fmtDuration(status.hiddenMs) }}
            <span class="opacity-70">({{ $t('devices.sinceAppStart') }})</span>
          </p>
```

Add the formatter to the page's `<script setup>`, next to the existing helpers:

```typescript
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}
```

The status object refreshes on the page's existing 5 s poll (`[id].vue:27`), so the elapsed duration re-renders without a second timer.

- [ ] **Step 5: Verify the build and the suite**

Run: `pnpm test && pnpm build`
Expected: PASS and BUILD SUCCESSFUL. A missing i18n key surfaces at runtime, not build time — check both locale files parse: `node -e "JSON.parse(require('fs').readFileSync('i18n/locales/uk.json'))"`.

- [ ] **Step 6: Verify by hand against a running dev server**

Run `pnpm dev`, open `/devices`, and confirm no badge appears for a normal device (every seeded device is `unknown`). Then simulate one:

```bash
curl -sX POST localhost:5100/api/devices/<id>/telemetry \
  -H 'content-type: application/json' \
  -d '{"visibility":"background","foregroundPackage":"com.netflix.ninja","snapBacks":9,"focusLosses":3,"hiddenMs":42000}'
```

Expected: the amber "Covered by com.netflix.ninja" chip on the list row and the detail page, alongside an unchanged green status dot — and it disappears once the device ages past the online window.

- [ ] **Step 7: Commit**

```bash
git add app/components/VisibilityBadge.vue app/pages/devices i18n/locales
git commit -m "feat(dashboard): surface player occlusion and kiosk-integrity counters"
```

---

### Task 10: Docs and on-box verification

**Files:**
- Modify: `CLAUDE.md` (the "Android kiosk player (APK)" section)
- Modify: `docs/superpowers/specs/2026-08-23-kiosk-visibility-telemetry-design.md` (status line)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Document the gotcha in `CLAUDE.md`**

Add a bullet to the "Android kiosk player (APK)" section:

```markdown
- **Player visibility telemetry.** The APK reports whether it is actually on
  screen — `foreground` / `obscured` (a dialog is on top: focus lost with no
  `onStop`, the one kiosk failure snap-back can never fix) / `background` —
  plus `snapBacks`/`focusLosses`/`hiddenMs`. The player samples every 2 s and
  posts on a state change, with a 30 s heartbeat as the floor — a beat alone
  would miss an occlusion that starts and ends between two beats. State lives in
  `KioskVisibility` (`src/main`, shared by both surfaces), fed by `KioskActivity`'s
  `onStart`/`onResume`/`onPause`/`onStop`/`onWindowFocusChanged` (`onPause`
  matters: a translucent overlay never calls `onStop`). The intruder package
  comes from `ForegroundAppProbe`, whose lookback window is derived from the
  episode length, and is `null` unless the box got
  `appops set ai.lanka.kiosk GET_USAGE_STATS allow`. One `KioskVisibility.shared`
  serves both player surfaces and survives the `recreate()` of a `set-surface`
  switch, so the counters are process totals, not per-surface ones — and
  `NativeSurface` owns its sampling scheduler, shutting it down in `stop()` per
  the `PlayerSurface` contract. **`telemetry.currentItemId`
  is now OPTIONAL** — absent means "heartbeat: don't touch the current item,
  don't count a play"; `null` still clears. Sending the current item on every
  heartbeat would inflate `media.play_count` by 120x/hour. Note the two signals
  that still lie about occlusion: the screenshot command draws the WebView's own
  view tree (`webView.draw`), not the display, and `lastSeenAt` keeps refreshing
  while hidden because the WebView is never `onPause()`d.
```

- [ ] **Step 2: Flip the spec status line**

In the spec, change `**Status:** Design approved` to `**Status:** Implemented <date>; on-box verification pending`.

- [ ] **Step 3: Commit the docs**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-23-kiosk-visibility-telemetry-design.md
git commit -m "docs(kiosk): visibility telemetry contract and the two signals that still lie"
```

- [ ] **Step 4: On-box verification (manual gate — do not tick without running it)**

Build against a reachable dev server and install the APK:

```bash
cd android
./gradlew :app:assembleDebug -PLANKA_SERVER_URL=http://<host>:5100
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell appops set ai.lanka.kiosk GET_USAGE_STATS allow
```

One APK, one grant, one launch (`adb shell am start -n ai.lanka.kiosk/.MainActivity`) — the surface is chosen at runtime, so both players are exercised from this single install.

Verify against a **production** server build (`pnpm build` + `node .output/server/index.mjs`), never `pnpm dev` — the unbundled dev module graph is too heavy for these boxes.

Checks:
1. Player playing, untouched → badge absent, `visibility` `foreground` within 30 s.
2. Press HOME → the ~400 ms snap-back returns the player. Badge must **not** appear (debounce), but `snapBacks` increments.
3. `adb shell am start -a android.settings.SETTINGS`, leave it up >2 s → chip reads "Covered by com.android.settings" within a few seconds (change-driven post, not the 30 s beat); returning to the player clears it just as fast.
   3a. Leave Settings up for **> 60 s**, then check the chip still names it — this is the regression test for the episode-derived probe window; a fixed short lookback would have degraded to "Not on screen".
   3b. Trigger a dialog over the player (e.g. a system prompt) without leaving the app → chip reads "Dialog on top", proving `obscured` is reachable and that the snap-back never fired.
4. Send `kiosk-unlock` from the dashboard, leave the player → state goes `background`, `snapBacks` stays put (an unlocked box arms no return).
5. Send `set-surface { surface: "native" }` from the dashboard and repeat checks 1–3 on the native surface. Both surfaces are in this one APK, so no second install and no second appop grant.
6. Confirm `media.play_count` did not move during any of it.
7. **Surface-switch hygiene** (new in the single-APK world). Note `snapBacks` and the badge, send `set-surface` to switch, and confirm after the `recreate()`:
   - the badge did **not** blink to "Not on screen" — the 2 s debounce should absorb the switch;
   - `snapBacks` did **not** increment — `scheduleKioskReturn` is guarded by `!isChangingConfigurations`, but this is the check that proves it. If it did move, gate `onSnapBackScheduled()` on a flag set by `SurfaceSwitcher.request` rather than widening the debounce;
   - counters did **not** reset — `KioskVisibility.shared` is process-wide and a surface switch is only an Activity `recreate()`, so the totals must carry across;
   - telemetry posts did not double — proof that `NativeSurface.stop()` shut the sampling scheduler down instead of leaking it.

---

## Self-Review Notes

Spec coverage checked section by section: state model and lifecycle inputs → Tasks 1–2; counters and one-per-departure snap-backs → Tasks 1–2; episode-scoped debounce → Task 1; intruder package and episode-derived probe window → Tasks 3, 7, 8; wire contract and `currentItemId` optionality → Task 4; coupled package semantics → Task 4; data model → Task 4; server design → Tasks 4–5; dashboard badge, counters and "hidden for N" → Task 9; web player enrichment and sampling tick → Task 6; native enrichment and tick → Task 8; testing → Tasks 1, 4, 5, 6, 8; risks → Tasks 9 and 10.

Names verified consistent across tasks: `KioskVisibility.shared`, `State.wire`, `Snapshot(state, snapBacks, focusLosses, hiddenMs, episodeMs, changeSeq)`, `Snapshot.toJson()` (no package argument), `KioskVisibility.shouldPost`, `ForegroundAppProbe.current(context, episodeMs)`, `NativeFS.visibility()` / `NativeFS.foregroundPackage(episodeMs)`, `createVisibility` / `VisibilitySnapshot` / `shouldPost`, `useTelemetry(api, visibility?)`, `Telemetry.heartbeat(deviceId)`, `TelemetryClient(poster, apkVersion, surface, visibility)`, and the six DB columns.

Traced by hand against the Task 1 implementation, since these are the cases Codex flagged: initial `BACKGROUND`; `live()` reaching `FOREGROUND` with no debounce; `onPause` alone producing `OBSCURED`; an `OBSCURED`→`BACKGROUND` move at 1.9 s still surfacing at exactly 2.0 s; a 400 ms excursion charging 400 ms of `hiddenMs` and one snap-back while never surfacing a state; a backwards clock leaving `hiddenMs` unchanged; `changeSeq` moving only when the reportable state moves.

### Revision for the single-APK merge (2026-08-24)

Rewritten after `c22632c`/`10e37e8` merged the two flavors into one APK. Changes: all source-set paths collapsed to `src/main` and `src/test`; `assembleWebviewDebug`/`assembleNativeDebug` and the per-flavor unit-test tasks replaced by `./gradlew test assembleDebug`; Task 7's bridge path moved out of the deleted `src/webview`; Task 8 retargeted from the deleted `PlayerActivity` to `NativeSurface`, with the sampling scheduler bound to the `PlayerSurface` start/stop ownership rule; the dual `ai.lanka.kiosk.vs` appop grant dropped, which retires Codex finding 10 entirely; and Task 10 gained a surface-switch hygiene check covering badge flicker, snap-back inflation, counter reset, and scheduler leaks across `recreate()`.

### Codex review outcome

One finding was **rejected**: adding a `kind: 'heartbeat' | 'item-start' | 'clear' | 'error'` discriminator to the telemetry body instead of relying on an absent `currentItemId`. Codex's own repo-wide trace confirms no current producer breaks under optionality, and a discriminator does not remove the failure mode it targets — a caller that would omit a field can just as easily send the wrong `kind`. To stay backward compatible with un-upgraded APKs the discriminator would itself have to be optional, reintroducing exactly the ambiguity it was meant to remove. The optional-field semantics are documented in the schema, in `CLAUDE.md`, and pinned by four tests in Task 4.
