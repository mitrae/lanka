# Single APK with a runtime-selectable player surface

**Date:** 2026-08-23
**Status:** Design approved (brainstormed with Claude; architecture cross-checked with Codex, which independently ranked the chosen option first). Revised 2026-08-23 after the Codex plan review: process-token cold-start detection, clean-load `onPageOk`, renderer death before confirmation = start failure, age-capped OTA busy flag, fail-closed package guard, debounced restart, process-wide store lock.
**Related:** `2026-06-28-lanka-native-exoplayer-flavor-design.md` (the two-flavor layout this replaces), `2026-06-21-device-remote-management-design.md` (command channel), `2026-08-23-kiosk-pin-unlock-design.md` (shared `KioskActivity` / PIN pad that must keep working), `2026-08-23-kiosk-visibility-telemetry-design.md` (owns "black but alive" detection — explicitly *not* duplicated here)

## Summary

Merge the two Android product flavors — `webview` (`ai.lanka.kiosk`, HTML5
`<video>` in a WebView) and `native` (`ai.lanka.kiosk.vs`, ExoPlayer) — into
**one APK, one package (`ai.lanka.kiosk`), one device row, one kiosk**, with the
player surface chosen **at runtime from the dashboard**.

A new device command, `set-surface { surface: "webview" | "native" }`, persists
the choice in the box's SharedPreferences and restarts the player Activity. The
choice survives reboot. Rollback is flipping it back — no OTA. A crash-loop
guard reverts a switch that cannot start, so a bad choice cannot strand a box
whose only remote path runs *inside* the surface that just died.

Architecturally there is exactly **one launcher component, `ai.lanka.kiosk/.MainActivity`**
(unchanged name), which hosts a pluggable `PlayerSurface`. Boot, HOME pinning,
lock task, the snap-back watchdog and the PIN pad are untouched.

## Motivation

Today a box that has both flavors installed registers as **two device rows**,
and both APKs boot locked and fight for the foreground (each one's snap-back
watchdog re-launches itself when it lands behind the other). There is no way to
pick the surface from the web UI; choosing one means building and installing a
different package. The native flavor was on-box verified on 2026-08-23, so the
question is no longer "does ExoPlayer work" but "how do we roll it out to ~50
TVs and back off per box when it doesn't".

## Decisions (locked during brainstorming)

1. **Single Activity + pluggable surface (option B)**, not activity-aliases
   toggled through `PackageManager.setComponentEnabledSetting` (option A) and
   not a no-UI trampoline launcher (option C). See "Rejected alternatives" for
   the verified reasons.
2. **The box is the only place the choice lives.** One SharedPreferences key;
   absent means `webview`, so the existing fleet keeps behaving after the OTA.
3. **The server stores nothing new.** `devices.surface` stays the *reported*
   truth (from register/telemetry). The newest `set-surface` command row is the
   *requested* state. No `desired_surface` column, no reconciliation loop —
   the command hub already queues for offline boxes and drains in order, and
   applying the same surface twice is a no-op, so redelivery is idempotent.
4. **The web player must report its surface.** Today it never sends `surface`
   (the column default does the work). After a native→webview flip on the same
   row the badge would be stuck on "Native". The web player sends
   `surface: "webview"` on register and telemetry.
5. **Crash-loop guard on the box**, because a dead surface means the WS command
   channel never comes up and the remote flip-back never arrives. Revert to the
   last-known-good surface after 3 cold starts within 10 minutes of an
   unconfirmed switch, immediately on a synchronous start failure, or when the
   WebView renderer dies before its first clean page load. A cold start is a
   **new OS process** (a per-process token compared with a stored key), never
   a `recreate()`. **No time-deadline rollback** (a server outage must not cause a spurious revert)
   and **no AlarmManager watchdog** — "black but alive" detection belongs to
   the visibility-telemetry spec.
6. **A switch during an OTA is refused**, never deferred: `failed: ota in
   progress`. The operator retries.
7. **Switching proceeds under lock task and while the PIN pad is showing.**
   `recreate()` keeps lock task (it is per-task, and `onResume` reconciles
   anyway), `KioskLock` and the `KioskPin` lockout are process-wide, and the
   pad is dismissed by `onPause` exactly as it is today on any pause.
8. **`apk_releases.flavor` is dropped.** One APK makes the tag meaningless, and a
   stale `-vs` release pushed over OTA would *install a second package* and
   recreate the two-launcher fight. The runbook deletes those releases and the
   box refuses any archive whose package name is not its own.
9. **Each surface owns its own command channel**, exactly as today — the JS
   `useCommandChannel` inside the WebView surface, the Kotlin `CommandClient`
   inside the native surface. `NativeFSBridge` exists only inside the WebView
   surface. Exactly one channel exists because exactly one surface exists.
10. **One ~6 MB APK for everyone.** The WebView-only APK was 1.9 MB; Media3 +
    OkHttp + serialization now ship to every box. Accepted.

## Non-goals

- Group- or address-level surface settings; a bulk switch. Per device only.
- Switching from the PIN pad or any on-box UI.
- A `desired_surface` column with server-side convergence / generation counters.
- A hang watchdog for a surface that starts but shows nothing (visibility
  telemetry spec).
- Relaunching after an OTA on a box that is **not** device owner (no
  `MY_PACKAGE_REPLACED` receiver exists today; the HOME pin does this on
  provisioned boxes). Pre-existing gap, worth its own ticket.
- Gating the OTA release picker by surface (moot once there is one APK).

## Architecture

### Android — build and source layout

`android/app/build.gradle.kts`:

- Remove `flavorDimensions += "surface"` and the `productFlavors` block.
- Remove the `native`, `webview` and `testNative` entries from `sourceSets`;
  only `main` (`src/main/kotlin`) remains and `test` is the default.
- Every `"nativeImplementation"(...)` becomes `implementation(...)`. The
  duplicate `testImplementation("…kotlinx-serialization-json…")` goes (an
  `implementation` dependency is already on the unit-test classpath).
- `versionName = "0.3.0-surface"`.
- `assembleDebug`, `assembleRelease`, `test` / `testDebugUnitTest` are the
  tasks again; `assembleWebviewDebug` / `assembleNativeDebug` /
  `testNativeDebugUnitTest` cease to exist.

Manifests: `src/main/AndroidManifest.xml` gains the `MainActivity` declaration
(`singleTask`, landscape, `configChanges` as today, the
MAIN/LAUNCHER/LEANBACK_LAUNCHER filter and the MAIN/HOME/DEFAULT filter —
byte-for-byte the block now in `src/webview/AndroidManifest.xml`).
`src/webview/AndroidManifest.xml`, `src/native/AndroidManifest.xml` and
`src/native/res/values/strings.xml` (the "Lanka-vs" label) are deleted. The
label is "Lanka", the package `ai.lanka.kiosk`.

Files move with `git mv` so history follows them:

| from | to |
|---|---|
| `src/webview/kotlin/ai/lanka/kiosk/{LankaChromeClient,NativeFSBridge}.kt` | `src/main/kotlin/ai/lanka/kiosk/` (NativeFSBridge gains `setSurface`) |
| `src/webview/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt` | `src/main/kotlin/ai/lanka/kiosk/` (+ per-navigation main-frame failure tracking; `onPageOk` only on a clean load) |
| `src/webview/kotlin/ai/lanka/kiosk/MainActivity.kt` | `src/main/kotlin/ai/lanka/kiosk/MainActivity.kt` (body moves to `WebViewSurface`) |
| `src/native/kotlin/ai/lanka/kiosk/player/*.kt` | `src/main/kotlin/ai/lanka/kiosk/player/` (unchanged) |
| `src/native/kotlin/ai/lanka/kiosk/PlayerActivity.kt` | `src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt` (refactored, see below) |
| `src/native/res/layout/activity_player.xml` | `src/main/res/layout/activity_player.xml` (inflated by `PlaybackView`; unchanged) |
| `src/webview/res/layout/activity_main.xml` | deleted — `WebViewSurface` creates the `WebView` programmatically |
| `src/testNative/kotlin/ai/lanka/kiosk/player/*Test.kt` | `src/test/kotlin/ai/lanka/kiosk/player/` (unchanged) |

Packages do not change (`ai.lanka.kiosk`, `ai.lanka.kiosk.player`). New files,
all in `src/main/kotlin/ai/lanka/kiosk/`: `PlayerSurface.kt`, `SurfaceStore.kt`,
`SurfaceSwitcher.kt`, `WebViewSurface.kt`, `NativeSurface.kt`.

### Android — `MainActivity` and the `PlayerSurface` contract

```kotlin
enum class SurfaceKind(val wire: String) {
    WEBVIEW("webview"), NATIVE("native");
    companion object { fun parse(s: String?): SurfaceKind? = entries.firstOrNull { it.wire == s } }
}
// Named SurfaceKind, not Surface: ai.lanka.kiosk.Surface would collide with
// android.view.Surface in any ExoPlayer-facing file of the same package.

interface PlayerSurface {
    /** Build views into the container and open the network. Main thread, called once. */
    fun start()
    /** Release EVERYTHING start() created. Idempotent. Called from onDestroy. */
    fun stop()
}
```

`MainActivity : KioskActivity` becomes a thin host:

```
onCreate(savedInstanceState):
  super.onCreate
  KioskFlags.apply(this)                                   // unchanged
  DevicePolicy.applyKioskPolicies(this, MainActivity::class.java)   // unchanged
  root = FrameLayout(black); setContentView(root)
  store = SurfaceStore(this)
  choice = store.onActivityCreate()                        // cold start? → guard may revert
  candidate = when (choice) {                              // SurfaceKind → concrete surface
      WEBVIEW -> WebViewSurface(this, root, onConfirmed = store::confirm, onStartFailed = ::handleStartFailure)
      NATIVE  -> NativeSurface(this, root, onConfirmed = store::confirm)
  }
  surface = candidate                                      // assign BEFORE start(): a half-started
  try { candidate.start() }                                // surface still needs stop()
  catch (e: Exception) {
      candidate.stop(); surface = null
      if (store.startFailed()) recreate()                  // reverted → try the other one
      else showFailureBanner()                             // nothing to revert to — never loop
  }

handleStartFailure():                                      // WebView renderer died before 1st clean load
  store.startFailed(); recreate()                          // revert if pending; restart either way

onDestroy:
  surface?.stop(); surface = null
  super.onDestroy
```

**Cold start = new OS process.** `ProcessToken` holds one random id per
process; `SurfaceStore.onActivityCreate()` compares it with the stored
`surface.process` key and counts a cold start only when they differ (then
stores ours). A `recreate()` — a switch, renderer recovery, the native
`reload` — happens inside the same process and is never counted; a crash
relaunched by the HOME pin, a reboot, BOOT_COMPLETED or an OTA is. This is
process identity, not `savedInstanceState` (which can be non-null after an
OS-restored Activity and is a framework timing detail).

**`WebViewSurface`** is today's `MainActivity` body, moved verbatim: creates the
`WebView` (black background, same `WebSettings`, the `LankaKiosk/<version>` UA
suffix), `LankaWebViewClient` with the same three callbacks, `NativeFSBridge`
registered as `NativeFS` with the same origin gate, `LankaChromeClient`, the
main-frame reload backoff (3 s → 30 s cap), renderer-gone recovery
(`destroy()` the WebView then `activity.recreate()`), the `OtaResultBus`
listener that evaluates `window.__otaResult`. It calls `onConfirmed()` from the
`onPageOk` callback. **`onPageOk` now means a clean load:** `LankaWebViewClient`
tracks a main-frame failure per navigation (network error, or an HTTP ≥ 400
document via `onReceivedHttpError`, both of which also trigger the reload
backoff) and fires `onPageOk` from `onPageFinished` only when none occurred.
Today it fires after an error too, which would confirm a broken surface as
healthy — and resets the reload backoff to 3 s on every failed attempt. A
**renderer death before the first clean load** calls the host's
`onStartFailed` instead of a plain `recreate()`: a recreate is not a cold
start, so a renderer that cannot survive the initial load would otherwise
loop without ever reverting.

**`NativeSurface`** (`@UnstableApi`) is today's `PlayerActivity` body, moved
verbatim: OkHttp client, `Json`, `MediaCache`, standby / no-content banners,
`TelemetryClient`, `ManifestClient` (`register("native", PLAYER_VERSION)`,
reconcile, SSE, 30 s poll, `onReload → activity.recreate()`), `CommandClient`
with the `CommandActions` object, `Scheduler` + `PlaybackView` per manifest,
the `bootIo` executor, the screenshot capture. It calls `onConfirmed()` from
the first `onManifest` callback (any manifest, including an empty one — the
signal is "registered and talking to the server", not "has content").

**Ownership rule (the one thing that makes B safe):** everything `start()`
creates, `stop()` releases, and `stop()` is idempotent. Each surface owns its
own `Handler(Looper.getMainLooper())` and cancels only its own callbacks. The
two subclasses' `mainHandler.removeCallbacksAndMessages(null)` in `onDestroy`
moves up into `KioskActivity.onDestroy` (it is `KioskActivity`'s handler and
`KioskActivity`'s posts — snap-back and PIN-pad idle timer — so this is a move,
not a behaviour change). Nothing else in `KioskActivity`, `KioskLock`,
`KioskPin`, `PinPadView`, `TapChord`, `DevicePolicy`, `BootReceiver`,
`OtaInstaller`'s install flow, `MediaCache` or `DeviceId` changes.

What the swap does **not** touch: the snap-back runnable (`Intent(this,
this::class.java)` → `MainActivity`), `DevicePolicy.setHomeLauncher`'s
persistent-preferred entry for `ai.lanka.kiosk/.MainActivity` (already present
on every provisioned box), `setLockTaskPackages` (package-scoped),
`BootReceiver`'s `getLaunchIntentForPackage` (one launcher component, always
enabled), `adb shell am start -n ai.lanka.kiosk/.MainActivity`, and
`dpm set-device-owner ai.lanka.kiosk/.LankaDeviceAdminReceiver`.

### Android — persisted choice, switch, crash-loop guard

Storage: SharedPreferences file `lanka_kiosk` (the one `DeviceId` already uses),
written with synchronous `commit()` so a process death right after a switch
cannot lose it.

| key | value | meaning |
|---|---|---|
| `surface` | `webview` \| `native` | the surface to run. **Absent → `webview`.** |
| `surface.lastGood` | `webview` \| `native` | last surface that confirmed health. Absent → `webview`. |
| `surface.pendingSince` | epoch ms | set by a switch, cleared on confirm/revert/expiry. Absent → not guarding. |
| `surface.starts` | int | cold process starts since `pendingSince`. |

`SurfacePolicy` is a pure state machine over a `SurfaceState(surface, lastGood,
pendingSince, starts)` value — no Android imports, so it is JVM-unit-tested
like `KioskPin` and `TapChord`. `SurfaceStore` is the thin SharedPreferences
adapter around it. Constants: `WINDOW_MS = 10 min`, `MAX_STARTS = 3`.

| event | rule |
|---|---|
| `requestSwitch(target, now)` | `target == surface` → no change (idempotent; the command is still acked). Else `surface = target`, `pendingSince = now`, `starts = 0`; `lastGood` untouched. |
| `onColdStart(now)` | not pending → nothing. Pending and `now − pendingSince > WINDOW_MS` → **stop guarding**: clear `pendingSince`/`starts`, keep `lastGood` (a long server outage must not revert a healthy switch). Pending and in window → `starts += 1`; if `starts ≥ MAX_STARTS` → **revert**: `surface = lastGood`, clear pending, log `surface <x> crash-looped (<n> cold starts in <m> min) — reverted to <lastGood>`. If `surface == lastGood` there is nothing to revert to → clear pending only. |
| `confirm()` | `lastGood = surface`, clear pending. Idempotent. |
| `startFailed()` | pending and `surface != lastGood` → revert (as above), return `true`. Otherwise clear pending, return `false` (caller must not `recreate()` — never loop on a surface that has nothing to fall back to). |

Only cold starts (new processes) count. A `recreate()` — the switch itself,
renderer-gone recovery after confirmation, the native `reload` — is not a cold
start, so a confirmed WebView box whose renderer dies twice mid-run is not
mistaken for a crash loop; a process that dies and is relaunched by the HOME
pin is. `SurfaceStore` serializes every mutation on one process-wide lock
(`MainActivity` on the main thread and `SurfaceSwitcher` on the JS-bridge /
WebSocket thread each construct their own instance).

Known limit: on a box that is **not** device owner nothing relaunches a crashed
process, so the counter only advances when someone presses HOME or the box
reboots. Those boxes still get the synchronous-failure revert and the remote
flip-back if the surface starts at all.

`SurfaceSwitcher.request(activity, name): String?` — thread-safe, callable from
the JavaBridge or WebSocket thread; `null` means accepted:

1. `SurfaceKind.parse(name) == null` → `"unknown surface '<name>'"`.
2. `OtaInstaller.busy` → `"ota in progress"`.
3. `store.requestSwitch(target, now)` returned "no change" → `null` (nothing
   to do; ack as success).
4. Otherwise log and post `activity.recreate()` to the main thread after
   **`ACK_GRACE_MS = 500`**, **debounced** (one pending restart; a newer
   request cancels the older post) and guarded by `!isFinishing &&
   !isDestroyed`. The grace lets the ack frame leave the socket before the
   surface that owns the socket is torn down; the debounce means two toggles
   in quick succession (webview→native→webview before the first recreate
   fires) end with one recreate that reads the final committed value —
   `recreate()` is asynchronous, so the finishing/destroyed guard alone would
   not stop a second call on the same instance.

### Android — command handling and guards

- **`NativeFSBridge.setSurface(name: String): String`** — privileged (origin
  gated like `reboot`/`installApk`); returns `""` on success, else the reason
  (`"forbidden"` when the origin check fails). The bridge receives a
  `switchSurface: (String) -> String?` constructor dependency — `WebViewSurface`
  passes `{ SurfaceSwitcher.request(activity, it) }` — so the bridge itself
  needs no Activity reference.
- **`CommandActions.setSurface(name: String): String?`** (null = accepted) and
  a `"set-surface"` branch in `CommandDispatcher`: missing/blank
  `payload.surface` → `failed: missing surface`; non-null reason → `failed:
  <reason>`; null → `acked`. The ack is sent *before* the recreate fires
  (grace period), and OkHttp flushes queued frames before a close frame.
- **`OtaInstaller.busy`** (process-wide, backed by a `busySince` timestamp):
  set on entry to `downloadApk`; cleared on download failure, on every
  immediate install failure path — the whole `PackageInstaller` session
  sequence sits inside one try so `createSession`/`openSession` failures clear
  it too — on `STATUS_PENDING_USER_ACTION` (the system prompt is now in
  charge), and when `OtaInstallReceiver` delivers the final result. A switch
  while busy is refused with `"ota in progress"`. A successful install kills
  the process anyway. **Age-capped at `BUSY_MAX_MS = 15 min`:** a wedged OTA
  (the WebView died between download and install; a result broadcast that
  never came) must never block the rollback path for good.
- **Package-name guard in `OtaInstaller.installSilently`:** after the signer
  check, read `packageManager.getPackageArchiveInfo(apk)?.packageName`; refuse
  (`onImmediateFailure("failed")`) unless it equals `context.packageName`.
  **Fail closed** — an archive whose package name cannot be read is refused
  too: the SHA proves integrity against the server's hash, not identity, and
  `getPackageArchiveInfo` is the installer's own parser (unlike signature
  reading, which some ROMs genuinely can't do — that check stays fail-open).
  Pure helper `packageNameMatches(self, archive: String?)` for the unit test.
  This is what makes a forgotten `-vs` release harmless.

### Server

- `server/services/command-hub.ts`: `CommandType` gains `'set-surface'`.
  `server/db/schema.ts`: the `deviceCommands.cmd` drizzle enum gains it (the
  column has no SQL CHECK — type-only, **no migration**). `set-surface` uses
  the normal `pending → sent → acked|failed` flow; the device acks after the
  preference is committed, *before* it restarts.
- `server/api/devices/[id]/commands.post.ts`: the body gets a zod schema —
  `cmd: z.enum([...all types])`, `releaseId?: number`, `surface?: z.enum(['webview','native'])`.
  `set-surface` without `surface` → 400; payload is `{ surface }`. (Today the
  body is unvalidated; a typo'd surface must not reach a box.)
- `app/composables/player/usePlayerBoot.ts` `ensureRegistered` sends
  `surface: 'webview'`; `app/composables/player/useTelemetry.ts` adds
  `surface: 'webview'` to every telemetry body. The register/telemetry
  handlers already accept it. (A plain browser tab is a WebView-class surface
  too, so this is always correct.)
- `app/composables/player/useCommandChannel.ts`: `Command.cmd` gains
  `'set-surface'`; handler: no bridge → `failed: not supported`; missing
  `payload.surface` → `failed: missing surface`; `nfs.setSurface(surface)`
  returns `""` → `acked`, else `failed: <reason>`.
- `app/types/api.ts` `DeviceCommand.cmd` and `useApiClient.enqueueCommand`'s
  body (`surface?`) updated.
- **Drop `apk_releases.flavor`:** remove the column from `schema.ts`
  (drizzle-kit generates `ALTER TABLE apk_releases DROP COLUMN flavor`),
  delete `parseApkFlavor` / `ApkFlavor` / the `flavor` form field in
  `server/api/apk/upload.post.ts`. The dashboard `ApkRelease` type never had
  the field and the upload form never sent it.
- `devices.surface`, `status.get.ts`, `register.post.ts`, `telemetry.post.ts`
  are unchanged.

### Dashboard — device page, Remote Control card

The static `Native`/`WebView` badge becomes a control:

- Reported badge (`status.surface`) labelled **Player surface**.
- One button, always naming the *other* surface: **Switch to Native** /
  **Switch to WebView**, behind a confirm modal: "The player restarts on the
  box. Rollback is switching back — no OTA." Confirm →
  `enqueueCommand(id, { cmd: 'set-surface', surface })`.
- State derived from the existing 10-second command poll, using the newest
  `set-surface` row (`payload` parsed for `surface`):

  | newest `set-surface` row | shows |
  |---|---|
  | `pending` / `sent` | "Switching to X… (queued / sent)", button disabled; older than 10 min → treated as lost, control returns to idle (a re-send supersedes the stuck row) |
  | `acked`, reported ≠ requested, `updatedAt` < 3 min ago | "Applying X…" (box relaunching; telemetry will flip the badge) |
  | `acked`, reported = requested | nothing extra |
  | `failed` | the `result` inline (e.g. *ota in progress*), button enabled |

- The reported badge already refreshes with the existing 5-second
  `refreshStatus` poll, so it flips without a page reload.
- The reboot command's confirm text ("The device will reload the kiosk
  WebView.") becomes surface-neutral. (Superseded 2026-08-24: the button was
  renamed **Reboot device** and its confirm text now names the device-owner
  fallback — see the 2026-06-21 remote-management spec.)

### Data flow of one switch

```
operator clicks "Switch to Native" → confirm
  → POST /api/devices/:id/commands { cmd: 'set-surface', surface: 'native' }
  → hub inserts row (pending) → WS delivery → row sent
box (WebView surface): JS useCommandChannel → NativeFS.setSurface('native')
  → SurfaceSwitcher.request: commit surface=native, pendingSince=now, starts=0
  → returns "" → JS sends { acked } → row acked
  → +500 ms: MainActivity.recreate()
  → onDestroy: WebViewSurface.stop() (WebView destroyed, bridge gone, WS closed)
  → onCreate (same process → not a cold start): store says native → NativeSurface.start()
  → ManifestClient.register(surface="native") → devices.surface = 'native'
  → first onManifest → store.confirm(): lastGood=native, pending cleared
dashboard: next status poll shows the Native badge; "Applying…" clears
```

The reverse path is symmetric: the native `CommandDispatcher` → `CommandActions.setSurface` → same `SurfaceSwitcher`; after the recreate the web player's register sends `surface: 'webview'`.

### Rejected alternatives

**A — two Activities + two `<activity-alias>` launchers toggled with
`PackageManager.setComponentEnabledSetting`** (the original lean). Verified
against framework behaviour (and independently by Codex):

- `getLaunchIntentForPackage` does exclude disabled components, so
  `BootReceiver` would follow the enabled alias.
- The device-owner HOME pin does **not** follow. `addPersistentPreferredActivity`
  is matched against the *resolved candidate list*; a disabled alias silently
  drops out and the box falls back to the stock launcher's chooser until
  something re-pins. The pinned `ComponentName` must be the **alias's** — the
  `MainActivity::class.java` that `applyKioskPolicies` passes today becomes
  wrong the moment the HOME filter moves onto an alias.
- `setComponentEnabledSetting` **kills the process** unless `DONT_KILL_APP` is
  passed; on a non-device-owner (snap-back) box nothing relaunches it.
- The switch is a five-step sequence (enable new → re-pin HOME → start new →
  disable old → finish) whose failure states — zero launchers, two launchers —
  are persisted in PackageManager state that survives OTA and that no OTA can
  repair.
- Two sources of truth (PM component state + a SharedPreferences mirror).

**C — two Activities unchanged + a `Theme.NoDisplay` trampoline** owning
LAUNCHER/HOME and routing by preference. Stable launcher like B, but adds a
must-finish-in-`onCreate` trampoline hop to every boot and every HOME press —
precisely the transition cheap OEM ROMs mishandle.

**Server-side `desired_surface` + reconciliation** (Codex's preference).
Rejected: no other command converges (kiosk-lock, OTA are one-shot), the hub
already queues for offline boxes and drains in `createdAt` order so the last
toggle wins, and re-applying the same surface is a no-op. The UI shows
requested vs reported explicitly instead.

**Time-deadline / AlarmManager rollback.** Rejected: a server outage after a
switch would revert a healthy surface; hang detection is the visibility
telemetry spec's job.

**Deferring a switch until after an in-flight OTA.** Rejected for the simpler
refuse-and-retry; a deferred switch would depend on the post-OTA relaunch,
which on non-owner boxes does not exist.

## Migration runbook

1. Build the merged APK: `cd android && ./gradlew :app:assembleDebug
   -PLANKA_SERVER_URL=<url> -PKIOSK_PIN=<pin>` → `app/build/outputs/apk/debug/app-debug.apk`.
   Upload it on the APK page as `0.3.0-surface`.
2. **Delete every old `-vs` release** on the APK page before pushing anything.
   (The on-box package-name guard is the backstop, not the plan.)
3. Bench boxes that have `ai.lanka.kiosk.vs` installed:
   - `adb shell dumpsys device_policy | grep -i owner` — if `ai.lanka.kiosk.vs`
     is **not** the device owner: `adb uninstall ai.lanka.kiosk.vs`.
   - If it **is** the device owner: a device-owner app cannot be uninstalled,
     and `dpm remove-active-admin` only works for `android:testOnly` builds.
     Factory-reset the box and re-provision with `ai.lanka.kiosk` per
     `android/README.md`.
   - Either way, delete the now-offline `.vs` device row on the Devices page
     (it has a different `deviceId`; nothing adopts it).
4. Push the OTA to the fleet. Every box keeps `ai.lanka.kiosk`, its
   `deviceId`, its device row, its HOME pin and device-owner status, and boots
   `webview` (no preference stored). The badge now reads WebView from an
   explicit report, not the column default.
5. On one box: Switch to Native → badge flips within a minute → reboot → still
   Native → open the PIN pad, unlock, re-lock → Switch to WebView → badge flips
   back. Then: push an OTA and, mid-download, Switch — expect `failed: ota in
   progress`. Pull the power mid-switch — expect the box to come up on the
   surface that was committed, or reverted if it crash-loops.
6. Docs: `README.md`, `android/README.md`, `CLAUDE.md` drop the flavor
   instructions (`assembleWebviewDebug`, `assembleNativeDebug`,
   `testNativeDebugUnitTest`, `src/testNative`, `ai.lanka.kiosk.vs`,
   "Lanka-vs") and describe the single APK + `set-surface`.

## Testing

**Android JVM (`./gradlew test`)**

- `SurfacePolicyTest` — same-target request is a no-op; a switch sets
  `pendingSince`/`starts=0` and leaves `lastGood`; cold starts inside the
  window increment; the third reverts to `lastGood` and clears pending; a
  cold start after the window clears pending without reverting; `confirm`
  sets `lastGood` and clears pending; `startFailed` reverts only when pending
  and `surface != lastGood`, otherwise clears pending and returns false;
  absent keys parse as `webview`/`webview`/not pending.
- `CommandDispatcherTest` — `set-surface` with no payload → `failed: missing
  surface`; action returns a reason → `failed: <reason>`; returns null →
  `acked`.
- `OtaInstallerTest` — `packageNameMatches`: equal → true, different → false,
  null archive → **false**; `busy` clears on a failed download (malformed URL,
  no network), stays set after a cache-hit download, and `isBusy(now)` expires
  after `BUSY_MAX_MS`.
- The moved `src/testNative` suites run unchanged in the single unit-test task.
- `WebViewSurface`, `NativeSurface`, `NativeFSBridge.setSurface`,
  `SurfaceSwitcher` are build-verified (Android framework types); their logic
  is in the pure classes above.

**Vitest (`pnpm test`)**

- `commands.post`: `set-surface` without `surface` → 400; with it → payload
  `{ surface }`; unknown `cmd` → 400.
- `useCommandChannel`: `set-surface` → `nfs.setSurface` called with the
  surface, `""` → acked, reason → failed, no bridge → `not supported`,
  missing payload → failed.
- `usePlayerBoot` register body and `useTelemetry` body carry
  `surface: 'webview'`.
- `apk/upload` rejects nothing and stores nothing for `flavor`.

**Gates:** `pnpm test`, `pnpm build`, `cd android && ./gradlew test
:app:assembleDebug`. Typecheck is not a gate (pre-existing vue-tsc noise).

**On-box (manual, the real merge gate):** runbook step 5.

## Risks & mitigations

| risk | mitigation |
|---|---|
| A sloppy `stop()` leaves a WebView / ExoPlayer / SSE socket / executor / `OtaResultBus` listener alive across the swap | Ownership rule; every resource created in `start()` is listed and released in `stop()`; `stop()` idempotent; checklist item in the plan's review step |
| The new surface crash-loops and the remote flip-back can never arrive | Crash-loop guard (3 cold starts / 10 min) + synchronous-failure revert + renderer-death-before-confirmation revert; `lastGood` only advances on a confirmed (clean-load / first-manifest) surface |
| A wedged OTA leaves `busy` set and blocks every later switch | `busy` is age-capped at 15 min; all session failures clear it |
| A surface throws halfway through `start()` and leaks what it created | `surface` is assigned before `start()`; the catch calls `stop()` |
| A switch lands while the native surface is still registering | Boot stages re-check `stopped`; an unguarded `startPolling()` on the shut-down executor would throw on that thread and crash the process |
| Spurious revert during a server outage | No time-deadline rollback; window expiry stops guarding instead of reverting |
| A stale `-vs` release pushed over OTA installs a second package | Runbook deletes them; `OtaInstaller` refuses a foreign package name |
| Ack lost because the socket owner is torn down first | 500 ms grace before `recreate()`; OkHttp flushes queued frames before closing |
| Two quick toggles double-`recreate()` | One debounced pending restart in `SurfaceSwitcher` (+ `isFinishing`/`isDestroyed` guard); the last committed value wins |
| The badge lies after a flip back to WebView | The web player now reports `surface: 'webview'` explicitly |
| Process dies between the pref write and the restart | `commit()` (synchronous) for every `SurfaceStore` write |

## Documentation to update

- `CLAUDE.md`: replace the "Native player flavor" section and the flavor
  build/test commands with the single-APK layout, `set-surface`, the
  `SurfacePolicy` guard and the ownership rule.
- `README.md` / `android/README.md`: build commands, runbook, the `-vs`
  removal steps.
- Memory: `native-player-flavor` (flavors are gone) and a new note for the
  merged layout.
