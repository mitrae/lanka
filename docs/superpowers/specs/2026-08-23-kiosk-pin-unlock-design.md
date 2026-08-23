# On-device PIN unlock — local kiosk escape hatch

**Date:** 2026-08-23
**Status:** Design approved, pending implementation plan
**Related:** `2026-04-19-lanka-apk-kiosk-design.md` (WebView kiosk), `2026-06-21-device-remote-management-design.md` (dashboard command channel), `2026-06-28-lanka-native-exoplayer-flavor-design.md` (native flavor / shared source sets)

## Summary

Add a **locally-entered PIN** that takes a box out of kiosk mode from the remote
control, with no network involved. Long-press BACK on the remote opens a
D-pad-navigable PIN pad drawn over the player; a correct PIN clears
`KioskLock.locked`, releases lock task, and drops the operator into Android
Settings.

The entire feature lives in `android/app/src/main/` and is therefore inherited by
**both** flavors (`webview` and `native`) from one implementation. No server
change, no DB column, no manifest field, no dashboard change.

## Motivation

Kiosk mode can only be lifted one way today: the dashboard's `kiosk-unlock`
command, delivered over the WebSocket at `/api/devices/:id/ws`. That path is
useless in exactly the situations where you need it most — the box has dropped
off the tailnet, Tailscale lost its always-on setting after a power cut, the
WebSocket is wedged, or the app server is down. The box sits there playing (or
not playing) and the remote cannot escape it: BACK is swallowed and HOME snaps
back within 400 ms.

The result is a site visit for a problem that a four-digit code would have
solved. At ~50 TVs across venues that is the difference between a phone call and
a drive.

A second, weaker motivation: on a device-owner box the current remote unlock is
**already broken** (see "Latent bugs fixed", below), so today there is
effectively no working unlock at all on a properly-provisioned device.

## Decisions (locked during brainstorming)

1. **Audience is the emergency escape hatch** — you or a trusted technician, not
   venue staff. One shared fleet-wide secret is acceptable.
2. **Unlock is scoped to the current run.** Not persisted; a reboot always
   returns to locked. This matches `KioskLock`'s existing fail-safe semantics.
3. **On-screen PIN pad**, not a blind key sequence. Chosen deliberately over the
   cheaper eyes-free option.
4. **One native `View` overlay in the shared `KioskActivity`** — not a per-flavor
   UI, and not a separate Activity.
5. **The secret is local and compile-time.** It can never come from the server,
   because the server being unreachable is the premise of the feature.
6. **A correct PIN launches Settings.**

### Why a native overlay rather than an HTML one (decision 4)

Writing the pad once instead of twice is the obvious benefit, but not the
deciding one. The deciding one is **failure independence**: the moments that
call for an escape hatch are disproportionately the moments when the WebView
renderer has died, the player page is white, or JS is wedged. An HTML overlay
rendered by the player page is unavailable precisely then. A native `View` is
drawn by the Activity and works even when the content beneath it is a corpse.

A separate full-screen Activity was rejected for a different reason: launching
one fires `onUserLeaveHint`/`onStop` on the player, so the snap-back watchdog
schedules a re-foreground and stomps the PIN pad 400 ms later. That is solvable
with special-casing, but it adds moving parts around the one mechanism that must
not break.

## Non-goals

- Per-device or per-venue PINs.
- Delivering or rotating the PIN from the server or dashboard.
- Changing the PIN without rebuilding the APK.
- Reporting unlock events to the server as an audit trail. (A `Log.i` line is
  written, retrievable via the dashboard's existing **Pull logs** command.)
- Automatic re-lock on a timer. Re-lock is a reboot, or the dashboard's existing
  `kiosk-lock` command.
- Letting venue staff reclaim the TV for normal viewing. That is a different
  feature with a different threat model.

## Architecture

### New files (both in `src/main`, shared by both flavors)

**`KioskPin.kt`** — the whole state machine, with **zero Android imports** so it
runs under plain JVM unit tests:

```kotlin
class KioskPin(
    private val expectedSha256: String,   // empty = feature disabled
    private val pinLength: Int,
    private val now: () -> Long,          // injected clock, deterministic in tests
)
```

Responsibilities: accumulate digits, compare on reaching `pinLength`, count
consecutive failures, own the lockout window, expose current entry length for
the dot indicator. The injected clock mirrors the pure-core testing pattern the
native flavor already uses.

**`PinPadView.kt`** — a focusable Android `View`: 3×4 digit grid, filled/empty
dot indicators, and a lockout message. Consumes D-pad and number keys and
delegates every decision to `KioskPin`; it holds no policy of its own.

### Changed files

**`KioskActivity.kt`** — the trigger, the overlay lifecycle, and the unlock
action. The pad is attached with `addContentView()`, which stacks a view over
whatever `setContentView` installed. This is what lets one implementation serve
both flavors: `MainActivity` sets an XML layout containing a WebView,
`PlayerActivity` sets a bare `FrameLayout`, and neither needs to know the pad
exists.

**`KioskLock.kt`** — gains a change listener (see below).

**`DevicePolicy.kt`** — gains `stopKioskMode(activity)`, calling `stopLockTask()`
in the same `runCatching` style as its neighbours, guarded by the current
**lock-task state** (mirroring `startKioskMode`) rather than by `isDeviceOwner`.
`startKioskMode` is deliberately not device-owner-gated — it falls back to plain
screen pinning on an unprovisioned box — so the release path must be equally
ungated or it would strand a pinned non-owner device.

**`build.gradle.kts`** — one `buildConfigField` pair.

### The trigger

`KioskActivity.onKeyDown` currently returns `true` for BACK while locked, which
suppresses Android's long-press detection outright — `onKeyLongPress` can never
fire. The fix is the standard tracked-key pattern:

```kotlin
override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) {
        if (event != null && event.repeatCount == 0) event.startTracking()
        return true
    }
    return super.onKeyDown(keyCode, event)
}

override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) { showPinPad(); return true }
    return super.onKeyLongPress(keyCode, event)
}

override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) return true
    return super.onKeyUp(keyCode, event)
}
```

Short-press BACK behaves exactly as it does today.

### Key routing

A focused WebView consumes D-pad keys for its own page navigation, which would
otherwise starve the pad. Calling `requestFocus()` on `PinPadView` after
attaching it moves focus off the WebView, so digits arrive through the normal
view-hierarchy key dispatch. No `dispatchKeyEvent` override on the Activity is
required. On dismissal, focus returns to the content view.

### Auto-dismiss

The pad removes itself after **20 s** with no key input. This is mandatory, not
a nicety: the pad is drawn over a customer-facing screen, and a half-entered PIN
must never be left sitting on a shop wall.

### The unlock action

Order matters here — `startActivity` to another package is blocked while lock
task is active, so the release must precede the launch:

```kotlin
KioskLock.locked = false             // listener releases lock task (see below)
Log.i(TAG, "kiosk unlocked via PIN")
startActivity(Intent(Settings.ACTION_SETTINGS))
```

The player keeps running behind Settings. `scheduleKioskReturn()` already
early-returns when `!KioskLock.locked`, so the snap-back watchdog correctly
leaves the operator alone.

Launching Settings is not cosmetic. On a device-owner box `DevicePolicy`
`setHomeLauncher` makes Lanka the HOME activity, so releasing lock task leaves
you with a working BACK button and **no launcher to navigate to**. Without the
Settings jump, a successful unlock on a provisioned box would strand you.

Note that a PIN unlock does not lift `setStatusBarDisabled`, `setKeyguardDisabled`,
`DISALLOW_SAFE_BOOT` or `DISALLOW_FACTORY_RESET`. Those are device-owner
policies, not kiosk state. The escape hatch gets you into Settings; it does not
return the box to stock.

### Latent bugs fixed

Two defects surfaced while designing this. Both exist today and are independent
of the PIN feature; both are repaired by the same change.

1. **`onResume` re-pins unconditionally.** `KioskActivity.onResume` calls
   `DevicePolicy.startKioskMode(this)` with no reference to `KioskLock.locked`,
   so on a device-owner box any unlock is undone the moment the activity
   resumes.
2. **The dashboard `kiosk-unlock` command never releases lock task.** It sets
   the flag via `NativeFSBridge.setKioskLock` / `CommandDispatcher`, but nothing
   calls `stopLockTask()`. On a provisioned box the remote unlock is a no-op.
   This has gone unnoticed only because no box is device-owner provisioned yet.

The fix is to make lock-task state **follow the flag, regardless of who set it**.
`KioskLock` gains a listener:

```kotlin
object KioskLock {
    @Volatile var locked: Boolean = true
        set(value) { field = value; listener?.invoke(value) }
    @Volatile var listener: ((Boolean) -> Unit)? = null
}
```

`KioskActivity` registers in `onResume` and clears in `onPause`, applying
`startKioskMode`/`stopKioskMode` accordingly, and guards the existing `onResume`
call with `if (KioskLock.locked)`. Both the PIN pad and the dashboard command
then work identically on provisioned and unprovisioned boxes.

**Threading:** the listener fires on whichever thread set the flag. The PIN pad
sets it on the main thread, but the dashboard path does not — `NativeFSBridge`
runs on a JavaBridge thread and the native `CommandDispatcher` on the WebSocket
thread. `startLockTask()`/`stopLockTask()` must be called on the main thread, so
the listener body must hop through `mainHandler.post { … }`. `KioskLock.locked`
is already `@Volatile`, so the flag read itself is safe from any thread.

### PIN storage

Mirrors the existing `LANKA_SERVER_URL` pattern exactly:

```bash
./gradlew :app:assembleNativeDebug -PLANKA_SERVER_URL=http://lanka-server:3000 -PKIOSK_PIN=4931
```

Gradle hashes the property at configure time and bakes in
`BuildConfig.KIOSK_PIN_SHA256` plus `BuildConfig.KIOSK_PIN_LENGTH` — **the
plaintext PIN never appears in the APK**, so `strings` does not surrender it.

This is friction, not security, and the spec should not pretend otherwise:
anyone holding the APK can brute-force four digits offline in microseconds. The
hash defeats casual discovery, nothing more. The real control is that possessing
the APK already implies physical or fleet access.

**The default is empty, which disables the feature** — an APK built without
`-PKIOSK_PIN` has no PIN escape hatch at all, rather than a well-known one.
Long-press BACK does nothing in that build.

### Brute-force resistance

5 consecutive wrong entries → 60 s lockout, with the counter reset on success.
Calibrated to stop idle jabbing at the remote by someone in the venue without
locking out the one person who legitimately needs in at 11pm.

## Testing

`KioskPinTest` in **`src/test/`** — the shared source set, not `src/testNative/`.
`KioskPin` is a shared-flavor class, so per the project's flavor rule its tests
belong alongside `MediaCacheTest` and `OtaInstallerTest`; putting them in
`src/testNative` would exclude them from `testWebviewDebugUnitTest`.

Cases:

- correct PIN unlocks
- wrong PIN increments the failure count and clears the entry
- lockout engages on the 5th consecutive failure
- lockout expires against the injected clock
- input during lockout is rejected without extending it
- entry state resets on dismissal
- empty `expectedSha256` disables the feature (no entry ever succeeds)

Plus a `KioskLock` listener test: setting `locked` fires the listener with the
new value; a cleared listener is not called.

`PinPadView` and the Activity key handling are **build-verified, then verified on
a box** — the same standard the project already applies to transport and UI
code. Both flavors must be checked: `testWebviewDebugUnitTest` and
`testNativeDebugUnitTest`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pad left on screen in a venue | 20 s inactivity auto-dismiss |
| PIN extracted from the APK | Accepted and documented; sha256 raises the bar to deliberate effort. Physical/fleet access is already implied by holding the APK |
| Long-press BACK fires accidentally | Only opens the pad; the PIN still gates. Auto-dismiss cleans up |
| WebView steals D-pad keys | `requestFocus()` on the pad; verified on-box |
| Some ROM does not deliver `onKeyLongPress` | Verify on-box early. Fallback: detect via `repeatCount` threshold in `onKeyDown` |
| Operator forgets the PIN | It is fleet-wide and documented in the README build command; a reboot restores kiosk regardless |

## Out-of-scope / future

- Per-device PINs delivered in the manifest. Deliberately rejected: the manifest
  route is **public** (session-exempt, tailnet-gated only), so a PIN carried
  there would be readable by anyone who can reach the endpoint with a device ID.
  A per-device PIN needs an authenticated channel first.
- Gating the OTA release picker by device surface (pre-existing, unrelated).
- Venue-staff TV reclaim with auto re-lock.

## Documentation to update

- `android/README.md` — the `-PKIOSK_PIN` build property, the long-press
  gesture, and the empty-default-disables behaviour, in the kiosk-hardening
  section.
- Root `CLAUDE.md` — one line in the Android kiosk section noting that
  `KioskLock` is now listener-driven and that lock-task state follows the flag.
