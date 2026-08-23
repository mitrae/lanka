# Single APK with a runtime-selectable player surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the `webview` and `native` Android flavors into one `ai.lanka.kiosk` APK whose player surface (WebView or ExoPlayer) is chosen per box from the dashboard via a new `set-surface` device command, persisted on the box, reboot-safe, with a crash-loop guard and a no-OTA rollback.

**Architecture:** One launcher Activity (`MainActivity`, unchanged component name) hosts a `PlayerSurface` strategy — `WebViewSurface` (today's MainActivity body) or `NativeSurface` (today's PlayerActivity body) — chosen from a SharedPreferences key and swapped with `recreate()`. A pure `SurfacePolicy` state machine implements the crash-loop revert. Server side adds the `set-surface` command type + validation, the web player starts reporting `surface: 'webview'`, `apk_releases.flavor` is dropped, and the device page gets a switch control driven by the newest `set-surface` command row versus the reported `devices.surface`.

**Tech Stack:** Kotlin 1.9 / Android SDK 34 / Media3 1.3.1 / OkHttp 4.12 / JUnit 4 (`./gradlew test`); Nuxt 4 + Nitro + Drizzle (SQLite) + zod + Vitest; Nuxt UI v3.

**Spec:** `docs/superpowers/specs/2026-08-23-single-apk-runtime-surface-design.md` — read it first; every task below argues from it.

## Global Constraints

- Branch: `feat/single-apk-runtime-surface` (already created; the spec is committed on it). **Stage by explicit path only** (`git add <file> <file>`), never `git add -A` / `git add .` — another session may be committing docs to the same checkout.
- Gates are **`pnpm test`**, **`pnpm build`**, and **`cd android && ./gradlew test :app:assembleDebug`**. `pnpm typecheck` is NOT a gate (≈381 pre-existing vue-tsc errors).
- Package stays `ai.lanka.kiosk`; launcher component stays `ai.lanka.kiosk/.MainActivity`; `versionName` becomes `0.3.0-surface`.
- Preference file `lanka_kiosk`; keys `surface`, `surface.lastGood`, `surface.pendingSince`, `surface.starts`; absent `surface` → `webview`. All `SurfaceStore` writes use synchronous `commit()`.
- Guard constants: `WINDOW_MS = 10 * 60_000L`, `MAX_STARTS = 3`. Switch grace: `ACK_GRACE_MS = 500L`. OTA busy cap: `BUSY_MAX_MS = 15 * 60_000L`. A **cold start** is a new OS process (`ProcessToken` ≠ stored `surface.process`), never a `recreate()`.
- Wire names are exactly `webview` and `native` (command payload `{ "surface": "webview" | "native" }`, telemetry/register `surface`).
- Failure reasons returned by the box, verbatim: `unknown surface '<name>'`, `ota in progress`, `forbidden`, `missing surface`, `not supported`.
- Nothing in `KioskActivity` (except the one-line `onDestroy` in Task 7), `KioskLock`, `KioskPin`, `PinPadView`, `TapChord`, `DevicePolicy`, `BootReceiver`, `MediaCache`, `DeviceId` changes behaviour.
- Enum is named `SurfaceKind`, never `Surface` (collides with `android.view.Surface`).
- Commit after every task; conventional prefixes as used in this repo (`feat(kiosk):`, `refactor(android):`, `chore(android):`, `feat(api):`, `feat(dashboard):`, `docs(kiosk):`). End commit bodies with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Android commands run from `android/` (`cd android && ./gradlew …`). Expect the first Gradle invocation to take a few minutes.

---

## File structure

**Android (`android/app/`)**

| file | responsibility |
|---|---|
| `build.gradle.kts` | single-variant build; all deps `implementation` |
| `src/main/AndroidManifest.xml` | the only manifest; declares `MainActivity` (LAUNCHER/LEANBACK/HOME) |
| `src/main/kotlin/ai/lanka/kiosk/PlayerSurface.kt` | `SurfaceKind` enum + `PlayerSurface` interface |
| `src/main/kotlin/ai/lanka/kiosk/SurfacePolicy.kt` | pure crash-loop/switch state machine (`SurfaceState`, `SurfacePolicy`) |
| `src/main/kotlin/ai/lanka/kiosk/SurfaceStore.kt` | `ProcessToken` + SharedPreferences adapter around `SurfacePolicy` (process-wide lock) |
| `src/main/kotlin/ai/lanka/kiosk/SurfaceSwitcher.kt` | validate → persist → debounced delayed `recreate()` |
| `src/main/kotlin/ai/lanka/kiosk/MainActivity.kt` | thin host: policies, root view, pick + start surface, guard |
| `src/main/kotlin/ai/lanka/kiosk/WebViewSurface.kt` | WebView player (ex-MainActivity body) |
| `src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt` | ExoPlayer player (ex-PlayerActivity body) |
| `src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt` | + `setSurface` |
| `src/main/kotlin/ai/lanka/kiosk/OtaInstaller.kt` | + age-capped `busy`, + fail-closed package-name guard |
| `src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt` | `onPageOk` only on a clean main-frame load |
| `src/main/kotlin/ai/lanka/kiosk/OtaInstallReceiver.kt` | clears `busy` |
| `src/main/kotlin/ai/lanka/kiosk/player/CommandDispatcher.kt` | + `set-surface` |
| `src/test/kotlin/ai/lanka/kiosk/SurfacePolicyTest.kt` | new |
| `src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt` | + busy / package-name tests |
| `src/test/kotlin/ai/lanka/kiosk/player/*Test.kt` | moved from `src/testNative` |

**Server / app**

| file | responsibility |
|---|---|
| `server/services/command-hub.ts` | `CommandType` + `'set-surface'` |
| `server/db/schema.ts` | `deviceCommands.cmd` enum + `'set-surface'`; `apkReleases.flavor` removed |
| `server/db/migrations/0013_*.sql` | `DROP COLUMN flavor` (drizzle-generated) |
| `server/api/devices/[id]/commands.post.ts` | zod body; `set-surface` payload |
| `server/api/apk/upload.post.ts` | flavor parsing removed |
| `app/composables/player/useNativeDevice.ts` | `PLAYER_SURFACE = 'webview'` |
| `app/composables/player/usePlayerBoot.ts` | register sends `surface` |
| `app/composables/player/useTelemetry.ts` | telemetry sends `surface` |
| `app/composables/player/useReconciler.ts` | `NativeFSBridge.setSurface?` |
| `app/composables/player/useCommandChannel.ts` | `set-surface` handler |
| `app/composables/useApiClient.ts` | body types |
| `app/types/api.ts` | `DeviceCommand.cmd` |
| `app/utils/surfaceSwitch.ts` | pure view-state for the dashboard control |
| `app/pages/devices/[id].vue` | the switch control |
| `scripts/build-apk.sh` | renamed from `build-native-apk.sh`; single variant |

---

### Task 1: Collapse the flavors into one source set (no behaviour change)

After this task the app builds as a single variant, behaves exactly like today's `webview` flavor, and carries the native player code compiled-in but unreachable (`PlayerActivity` is no longer declared in any manifest; Task 6 turns it into `NativeSurface`).

**Files:**
- Modify: `android/app/build.gradle.kts`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Move (git mv): everything under `android/app/src/{webview,native,testNative}` → `src/main` / `src/test` (table below)
- Delete: `android/app/src/webview/AndroidManifest.xml`, `android/app/src/native/AndroidManifest.xml`, `android/app/src/native/res/values/strings.xml`
- Rename: `scripts/build-native-apk.sh` → `scripts/build-apk.sh`

**Interfaces:**
- Produces: single Gradle variant — tasks `:app:assembleDebug`, `:app:test`; APK at `android/app/build/outputs/apk/debug/app-debug.apk`. All classes from both flavors in `src/main/kotlin`.

- [ ] **Step 1: Move the files**

```bash
cd android/app/src
mkdir -p main/res/layout
git mv webview/kotlin/ai/lanka/kiosk/MainActivity.kt        main/kotlin/ai/lanka/kiosk/MainActivity.kt
git mv webview/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt  main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt
git mv webview/kotlin/ai/lanka/kiosk/LankaChromeClient.kt   main/kotlin/ai/lanka/kiosk/LankaChromeClient.kt
git mv webview/kotlin/ai/lanka/kiosk/NativeFSBridge.kt      main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt
git mv webview/res/layout/activity_main.xml                 main/res/layout/activity_main.xml
git mv native/kotlin/ai/lanka/kiosk/PlayerActivity.kt       main/kotlin/ai/lanka/kiosk/PlayerActivity.kt
git mv native/kotlin/ai/lanka/kiosk/player                  main/kotlin/ai/lanka/kiosk/player
git mv native/res/layout/activity_player.xml                main/res/layout/activity_player.xml
git mv testNative/kotlin/ai/lanka/kiosk/player              test/kotlin/ai/lanka/kiosk/player
git rm -q webview/AndroidManifest.xml native/AndroidManifest.xml native/res/values/strings.xml
ls webview native testNative 2>/dev/null   # expect: nothing left (empty dirs are fine; git ignores them)
cd ../../..
```

- [ ] **Step 2: Rewrite the Gradle variant config**

In `android/app/build.gradle.kts`:

Change `versionName = "0.2.0-pin"` → `versionName = "0.3.0-surface"`.

Delete this block entirely:

```kotlin
    flavorDimensions += "surface"
    productFlavors {
        create("webview") { dimension = "surface" }
        create("native") {
            dimension = "surface"
            applicationIdSuffix = ".vs"
            versionNameSuffix = "-vs"
        }
    }
```

Replace the `sourceSets { … }` block with:

```kotlin
    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
    }
```

Replace the `dependencies { … }` block with:

```kotlin
dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.webkit:webkit:1.9.0")

    // Native (ExoPlayer) surface. Formerly nativeImplementation-scoped; one APK
    // now carries both surfaces (~6 MB instead of 1.9 MB — accepted in the spec).
    val media3 = "1.3.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    testImplementation("junit:junit:4.13.2")
}
```

- [ ] **Step 3: Declare `MainActivity` in the single manifest**

In `android/app/src/main/AndroidManifest.xml`, insert this block inside `<application …>` immediately before `<receiver android:name=".BootReceiver"`:

```xml
        <!-- The ONE launcher component. Boot (BootReceiver → getLaunchIntentForPackage),
             the device-owner HOME pin (DevicePolicy.setHomeLauncher) and lock task all
             target this name; the player surface inside it is a runtime choice
             (see SurfaceStore / docs/superpowers/specs/2026-08-23-single-apk-runtime-surface-design.md). -->
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|keyboardHidden|navigation"
            android:screenOrientation="landscape">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
                <category android:name="android.intent.category.LEANBACK_LAUNCHER"/>
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.HOME"/>
                <category android:name="android.intent.category.DEFAULT"/>
            </intent-filter>
        </activity>

```

- [ ] **Step 4: Rename and simplify the build helper script**

```bash
git mv scripts/build-native-apk.sh scripts/build-apk.sh
```

Replace the whole content of `scripts/build-apk.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Build the Lanka kiosk APK (one package, both player surfaces — the surface is
# chosen per box from the dashboard). The server URL is compile-time
# (BuildConfig.LANKA_SERVER_URL), so "dev" and "prod" are separate builds.
#
# Usage:
#   scripts/build-apk.sh            # both (dev + prod)
#   scripts/build-apk.sh dev        # dev only
#   scripts/build-apk.sh prod       # prod only
#   scripts/build-apk.sh http://host:port   # an explicit URL
#
# Env:
#   LANKA_DEV_URL   (default http://100.123.113.86:5100 — dev box: local dev server on the tailnet, :5100)
#   LANKA_PROD_URL  (default http://100.79.177.86        — prod box: Hetzner, nginx tailnet block :80)
#   LANKA_KIOSK_PIN (optional; 4+ digits → baked PIN escape hatch, see android/README.md)
#
# Output (copied next to the gradle artifact, so dev+prod coexist on disk):
#   android/app/build/outputs/apk/debug/app-debug-DEV.apk
#   android/app/build/outputs/apk/debug/app-debug-PROD.apk

DEV_URL="${LANKA_DEV_URL:-http://100.123.113.86:5100}"
PROD_URL="${LANKA_PROD_URL:-http://100.79.177.86}"
PIN_ARG=()
if [[ -n "${LANKA_KIOSK_PIN:-}" ]]; then PIN_ARG=(-PKIOSK_PIN="$LANKA_KIOSK_PIN"); fi

cd "$(dirname "$0")/../android"
OUT_DIR="app/build/outputs/apk/debug"

build() {
  local label="$1" url="$2"
  echo "==> APK ($label) → $url"
  ./gradlew :app:assembleDebug -PLANKA_SERVER_URL="$url" "${PIN_ARG[@]}" --console=plain
  cp "$OUT_DIR/app-debug.apk" "$OUT_DIR/app-debug-${label}.apk"
  echo "    → $OUT_DIR/app-debug-${label}.apk"
}

case "${1:-both}" in
  dev)   build DEV  "$DEV_URL" ;;
  prod)  build PROD "$PROD_URL" ;;
  both)  build DEV  "$DEV_URL"; build PROD "$PROD_URL" ;;
  http*) build CUSTOM "$1" ;;
  *)     echo "usage: $0 [dev|prod|both|<http(s)-url>]" >&2; exit 1 ;;
esac
```

- [ ] **Step 5: Build and run the unit tests**

```bash
cd android && ./gradlew :app:assembleDebug test --console=plain 2>&1 | tail -15
```

Expected: `BUILD SUCCESSFUL`; `ls app/build/outputs/apk/debug/app-debug.apk` exists; the moved `player/*Test` suites ran (check `app/build/reports/tests/testDebugUnitTest/index.html` lists `ai.lanka.kiosk.player`). If `R.layout.activity_player` or `R.layout.activity_main` is unresolved, the layout moves in Step 1 were missed.

- [ ] **Step 6: Commit**

```bash
git add android/app/build.gradle.kts android/app/src scripts/build-apk.sh
git status --short | grep -v '^[MADR]' ; # expect nothing untracked/unstaged under android/ or scripts/
git commit -m "refactor(android): collapse the webview/native flavors into one source set

Single variant, single manifest, one package (ai.lanka.kiosk). Behaviour is
the old webview flavor; the native player code is compiled in but not yet
reachable. Spec: docs/superpowers/specs/2026-08-23-single-apk-runtime-surface-design.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`git mv`/`git rm` already staged the moves; `git add android/app/src` picks up the manifest edit.)

---

### Task 2: `SurfaceKind`, `PlayerSurface`, the pure `SurfacePolicy`, and `SurfaceStore`

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/PlayerSurface.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/SurfacePolicy.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/SurfaceStore.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/SurfacePolicyTest.kt`

**Interfaces:**
- Produces:
  - `enum class SurfaceKind(val wire: String) { WEBVIEW("webview"), NATIVE("native") }` with `SurfaceKind.parse(s: String?): SurfaceKind?`
  - `interface PlayerSurface { fun start(); fun stop() }`
  - `data class SurfaceState(surface, lastGood, pendingSince: Long?, starts: Int)` + `val pending: Boolean`
  - `object SurfacePolicy` — `requestSwitch(s, target, now): SurfaceState?`, `onColdStart(s, now): Outcome`, `confirm(s): SurfaceState`, `startFailed(s): Outcome`, `data class Outcome(state, reverted)`
  - `object ProcessToken { val id: String }` — one random id per OS process
  - `class SurfaceStore(context, now = System::currentTimeMillis, processId = ProcessToken.id)` — `requestSwitch(target): Boolean`, `onActivityCreate(): SurfaceKind`, `confirm()`, `startFailed(): Boolean`. All mutations serialize on one process-wide lock.

- [ ] **Step 1: Write the failing tests**

`android/app/src/test/kotlin/ai/lanka/kiosk/SurfacePolicyTest.kt`:

```kotlin
package ai.lanka.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfacePolicyTest {
    private val t0 = 1_000_000L
    private val window = SurfacePolicy.WINDOW_MS

    @Test fun `parse accepts exact wire names only`() {
        assertEquals(SurfaceKind.NATIVE, SurfaceKind.parse("native"))
        assertEquals(SurfaceKind.WEBVIEW, SurfaceKind.parse("webview"))
        assertNull(SurfaceKind.parse("Native"))
        assertNull(SurfaceKind.parse(null))
    }

    @Test fun `absent state runs webview and is not pending`() {
        val s = SurfaceState()
        assertEquals(SurfaceKind.WEBVIEW, s.surface)
        assertEquals(SurfaceKind.WEBVIEW, s.lastGood)
        assertFalse(s.pending)
    }

    @Test fun `requesting the current surface is a no-op`() {
        assertNull(SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.WEBVIEW, t0))
    }

    @Test fun `a switch sets pending and keeps lastGood`() {
        val s = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        assertEquals(SurfaceKind.NATIVE, s.surface)
        assertEquals(SurfaceKind.WEBVIEW, s.lastGood)
        assertEquals(t0, s.pendingSince)
        assertEquals(0, s.starts)
    }

    @Test fun `cold start when not pending changes nothing`() {
        val out = SurfacePolicy.onColdStart(SurfaceState(), t0)
        assertEquals(SurfaceState(), out.state)
        assertFalse(out.reverted)
    }

    @Test fun `cold starts inside the window count and the third reverts`() {
        var s = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        s = SurfacePolicy.onColdStart(s, t0 + 1_000).also { assertFalse(it.reverted) }.state
        assertEquals(1, s.starts)
        s = SurfacePolicy.onColdStart(s, t0 + 2_000).also { assertFalse(it.reverted) }.state
        assertEquals(2, s.starts)
        val out = SurfacePolicy.onColdStart(s, t0 + 3_000)
        assertTrue(out.reverted)
        assertEquals(SurfaceKind.WEBVIEW, out.state.surface)
        assertEquals(SurfaceKind.WEBVIEW, out.state.lastGood)
        assertFalse(out.state.pending)
        assertEquals(0, out.state.starts)
    }

    @Test fun `a cold start after the window stops guarding without reverting`() {
        val s = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!.copy(starts = 2)
        val out = SurfacePolicy.onColdStart(s, t0 + window + 1)
        assertFalse(out.reverted)
        assertEquals(SurfaceKind.NATIVE, out.state.surface)
        assertEquals(SurfaceKind.WEBVIEW, out.state.lastGood)
        assertFalse(out.state.pending)
        assertEquals(0, out.state.starts)
    }

    @Test fun `confirm promotes the surface to lastGood and clears pending`() {
        val s = SurfacePolicy.confirm(SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!)
        assertEquals(SurfaceKind.NATIVE, s.surface)
        assertEquals(SurfaceKind.NATIVE, s.lastGood)
        assertFalse(s.pending)
        assertEquals(0, s.starts)
    }

    @Test fun `startFailed reverts only while pending`() {
        val pending = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        val out = SurfacePolicy.startFailed(pending)
        assertTrue(out.reverted)
        assertEquals(SurfaceKind.WEBVIEW, out.state.surface)
        assertFalse(out.state.pending)

        val settled = SurfacePolicy.startFailed(SurfaceState(surface = SurfaceKind.NATIVE, lastGood = SurfaceKind.NATIVE))
        assertFalse(settled.reverted)
        assertEquals(SurfaceKind.NATIVE, settled.state.surface)
    }

    @Test fun `a flip back before confirmation leaves nothing to revert to`() {
        val toNative = SurfacePolicy.requestSwitch(SurfaceState(), SurfaceKind.NATIVE, t0)!!
        val back = SurfacePolicy.requestSwitch(toNative, SurfaceKind.WEBVIEW, t0 + 10)!!
        assertEquals(SurfaceKind.WEBVIEW, back.surface)
        assertEquals(SurfaceKind.WEBVIEW, back.lastGood)
        assertTrue(back.pending)
        var s = back
        repeat(2) { s = SurfacePolicy.onColdStart(s, t0 + 20).state }
        val out = SurfacePolicy.onColdStart(s, t0 + 30)
        assertFalse(out.reverted)
        assertEquals(SurfaceKind.WEBVIEW, out.state.surface)
        assertFalse(out.state.pending)
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests 'ai.lanka.kiosk.SurfacePolicyTest' --console=plain 2>&1 | tail -8
```

Expected: compilation failure — `Unresolved reference: SurfaceKind` / `SurfacePolicy`.

- [ ] **Step 3: Write `PlayerSurface.kt`**

```kotlin
package ai.lanka.kiosk

/**
 * Which player renders on this box. The wire name is what the dashboard sends
 * in `set-surface { surface }` and what register/telemetry report back.
 *
 * Named SurfaceKind, not Surface: `ai.lanka.kiosk.Surface` would collide with
 * `android.view.Surface` in any ExoPlayer-facing file of this package.
 */
enum class SurfaceKind(val wire: String) {
    WEBVIEW("webview"),
    NATIVE("native");

    companion object {
        /** Exact match on the wire name; null for anything else (incl. null). */
        fun parse(s: String?): SurfaceKind? = entries.firstOrNull { it.wire == s }
    }
}

/**
 * A player surface hosted by MainActivity. Exactly one exists at a time.
 *
 * Ownership rule (what makes the runtime swap safe): everything [start]
 * creates — views, WebView/ExoPlayer, sockets, SSE, executors, Handler posts,
 * OtaResultBus listener — [stop] releases. [stop] is idempotent and is called
 * from MainActivity.onDestroy (so from every recreate()).
 */
interface PlayerSurface {
    /** Build views into the host container and open the network. Main thread, once. */
    fun start()

    /** Release everything [start] created. Idempotent. */
    fun stop()
}
```

- [ ] **Step 4: Write `SurfacePolicy.kt`**

```kotlin
package ai.lanka.kiosk

/**
 * Persisted surface choice plus the crash-loop guard's bookkeeping.
 * Absent preferences map to the defaults here, so an OTA'd box with no key
 * keeps running the WebView player.
 */
data class SurfaceState(
    val surface: SurfaceKind = SurfaceKind.WEBVIEW,
    val lastGood: SurfaceKind = SurfaceKind.WEBVIEW,
    /** Epoch ms of an unconfirmed switch; null when not guarding. */
    val pendingSince: Long? = null,
    /** Cold process starts since [pendingSince]. */
    val starts: Int = 0,
) {
    val pending: Boolean get() = pendingSince != null
}

/**
 * Pure state machine for switching surfaces and reverting a switch that cannot
 * start. No Android imports — JVM-unit-tested like KioskPin/TapChord. The
 * SharedPreferences adapter is [SurfaceStore]; the policy is all here.
 *
 * Why a guard at all: the remote flip-back travels over the command channel
 * that lives INSIDE the surface. A surface that dies on start can never
 * receive the command that would undo it.
 *
 * Why only COLD starts count: a recreate() (the switch itself, renderer-gone
 * recovery, the native `reload` command) hands the new instance a non-null
 * savedInstanceState; a crash relaunched by the HOME pin, a reboot or
 * BOOT_COMPLETED does not. Counting every onCreate would mistake two renderer
 * recoveries for a crash loop.
 *
 * Why no deadline: a server outage right after a switch must not revert a
 * healthy surface. Window expiry stops guarding instead of reverting.
 */
object SurfacePolicy {
    const val WINDOW_MS = 10 * 60_000L
    const val MAX_STARTS = 3

    data class Outcome(val state: SurfaceState, val reverted: Boolean)

    /** Null when already on [target] (idempotent — the command is still acked). */
    fun requestSwitch(s: SurfaceState, target: SurfaceKind, now: Long): SurfaceState? =
        if (target == s.surface) null
        else s.copy(surface = target, pendingSince = now, starts = 0)

    fun onColdStart(s: SurfaceState, now: Long): Outcome {
        val since = s.pendingSince ?: return Outcome(s, false)
        if (now - since > WINDOW_MS) return Outcome(s.copy(pendingSince = null, starts = 0), false)
        val starts = s.starts + 1
        if (starts < MAX_STARTS) return Outcome(s.copy(starts = starts), false)
        return revert(s)
    }

    /** The surface proved healthy: it becomes the fallback for the next switch. */
    fun confirm(s: SurfaceState): SurfaceState =
        s.copy(lastGood = s.surface, pendingSince = null, starts = 0)

    /** Synchronous start failure. `reverted` tells the host whether to recreate(). */
    fun startFailed(s: SurfaceState): Outcome =
        if (s.pending) revert(s) else Outcome(s, false)

    private fun revert(s: SurfaceState): Outcome {
        val cleared = s.copy(pendingSince = null, starts = 0)
        // A flip-back requested before the first switch confirmed leaves
        // surface == lastGood: nothing to fall back to, so only stop guarding.
        return if (s.surface == s.lastGood) Outcome(cleared, false)
        else Outcome(cleared.copy(surface = s.lastGood), true)
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests 'ai.lanka.kiosk.SurfacePolicyTest' --console=plain 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`, 10 tests passed.

- [ ] **Step 6: Write `SurfaceStore.kt`** (Android adapter; build-verified)

```kotlin
package ai.lanka.kiosk

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.util.UUID

/**
 * Identity of the current OS process. [SurfaceStore] compares it with the
 * stored `surface.process` key to tell a COLD start (new process: crash
 * relaunched by the HOME pin, reboot, BOOT_COMPLETED, OTA) from a recreate()
 * inside the same process (a switch, renderer recovery, the native `reload`).
 * More robust than savedInstanceState, which can be non-null after an
 * OS-restored Activity and is a framework timing detail, not process identity.
 */
object ProcessToken {
    val id: String = UUID.randomUUID().toString()
}

/**
 * SharedPreferences adapter around [SurfacePolicy]. Same prefs file as
 * [DeviceId] ("lanka_kiosk"). Every write is a synchronous commit(): the host
 * recreate()s right after a switch and a process death in between must not
 * lose it.
 *
 * All mutations run under ONE process-wide lock: MainActivity (main thread)
 * and SurfaceSwitcher (JS-bridge / WebSocket thread) each construct their own
 * instance, so instance-level synchronization would not serialize them.
 */
class SurfaceStore(
    context: Context,
    private val now: () -> Long = System::currentTimeMillis,
    private val processId: String = ProcessToken.id,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): SurfaceState = SurfaceState(
        surface = SurfaceKind.parse(prefs.getString(KEY_SURFACE, null)) ?: SurfaceKind.WEBVIEW,
        lastGood = SurfaceKind.parse(prefs.getString(KEY_LAST_GOOD, null)) ?: SurfaceKind.WEBVIEW,
        pendingSince = if (prefs.contains(KEY_PENDING_SINCE)) prefs.getLong(KEY_PENDING_SINCE, 0L) else null,
        starts = prefs.getInt(KEY_STARTS, 0),
    )

    private fun save(s: SurfaceState) {
        val e = prefs.edit()
            .putString(KEY_SURFACE, s.surface.wire)
            .putString(KEY_LAST_GOOD, s.lastGood.wire)
            .putInt(KEY_STARTS, s.starts)
        if (s.pendingSince != null) e.putLong(KEY_PENDING_SINCE, s.pendingSince) else e.remove(KEY_PENDING_SINCE)
        e.commit()
    }

    /** True when a switch was recorded; false when already on [target]. */
    fun requestSwitch(target: SurfaceKind): Boolean {
        synchronized(LOCK) {
            val next = SurfacePolicy.requestSwitch(load(), target, now()) ?: return false
            save(next)
            return true
        }
    }

    /**
     * Call from MainActivity.onCreate. A cold start is a NEW PROCESS (the stored
     * process token differs from ours); a recreate() in the same process is not
     * one. Applies the crash-loop guard and returns the surface to run.
     */
    fun onActivityCreate(): SurfaceKind {
        synchronized(LOCK) {
            val s = load()
            val coldStart = prefs.getString(KEY_PROCESS, null) != processId
            if (!coldStart) return s.surface
            prefs.edit().putString(KEY_PROCESS, processId).commit()
            val out = SurfacePolicy.onColdStart(s, now())
            if (out.state != s) save(out.state)
            if (out.reverted) {
                Log.w(TAG, "surface ${s.surface.wire} crash-looped (${s.starts + 1} cold starts in " +
                    "${SurfacePolicy.WINDOW_MS / 60_000} min) — reverted to ${out.state.surface.wire}")
            }
            return out.state.surface
        }
    }

    /** The running surface proved healthy. Idempotent; cheap to call repeatedly. */
    fun confirm() {
        synchronized(LOCK) {
            val s = load()
            if (s.pending || s.lastGood != s.surface) save(SurfacePolicy.confirm(s))
        }
    }

    /** The surface could not start. Returns true when it reverted (host should recreate()). */
    fun startFailed(): Boolean {
        synchronized(LOCK) {
            val s = load()
            val out = SurfacePolicy.startFailed(s)
            if (out.state != s) save(out.state)
            if (out.reverted) Log.w(TAG, "surface ${s.surface.wire} failed to start — reverted to ${out.state.surface.wire}")
            return out.reverted
        }
    }

    companion object {
        private val LOCK = Any()
        private const val TAG = "LankaKiosk"
        private const val PREFS = "lanka_kiosk"
        private const val KEY_SURFACE = "surface"
        private const val KEY_LAST_GOOD = "surface.lastGood"
        private const val KEY_PENDING_SINCE = "surface.pendingSince"
        private const val KEY_STARTS = "surface.starts"
        private const val KEY_PROCESS = "surface.process"
    }
}
```

- [ ] **Step 7: Build + full Android tests**

```bash
cd android && ./gradlew :app:assembleDebug test --console=plain 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/PlayerSurface.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/SurfacePolicy.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/SurfaceStore.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/SurfacePolicyTest.kt
git commit -m "feat(kiosk): SurfaceKind, PlayerSurface contract, SurfacePolicy guard + SurfaceStore

Pure state machine for the runtime surface choice and the crash-loop revert
(3 cold starts in 10 min of an unconfirmed switch), plus the committing,
process-wide-locked SharedPreferences adapter. Cold start = new process
(ProcessToken), never a recreate().

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `OtaInstaller.busy` and the package-name guard

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstaller.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstallReceiver.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt`

**Interfaces:**
- Produces (all on the `OtaInstaller` companion): `busy: Boolean` (getter), `isBusy(now: Long): Boolean`, `clearBusy()`, `BUSY_MAX_MS = 15 * 60_000L`, `packageNameMatches(self: String, archive: String?): Boolean` (internal; **fail closed** — null archive → false).

- [ ] **Step 1: Write the failing tests**

Append inside `class OtaInstallerTest` in `android/app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt` (add `import org.junit.After` to the imports):

```kotlin
    @After
    fun resetBusy() { OtaInstaller.clearBusy() }

    @Test
    fun `packageNameMatches refuses a foreign or unreadable package`() {
        assertTrue(OtaInstaller.packageNameMatches("ai.lanka.kiosk", "ai.lanka.kiosk"))
        assertFalse(OtaInstaller.packageNameMatches("ai.lanka.kiosk", "ai.lanka.kiosk.vs"))
        assertFalse(OtaInstaller.packageNameMatches("ai.lanka.kiosk", null)) // fail CLOSED
    }

    @Test
    fun `busy clears when a download fails`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        // MalformedURLException → the download's catch → false. Deterministic, no network.
        assertFalse(installer.downloadApk("c".repeat(64), "not-a-valid-url"))
        assertFalse(OtaInstaller.busy)
    }

    @Test
    fun `busy stays set after a successful download and expires after BUSY_MAX_MS`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        val apkDir = File(tmp.root, "apk-cache").apply { mkdirs() }
        File(apkDir, "$abcSha.apk").writeBytes("abc".toByteArray()) // valid cache hit, no network
        val t0 = System.currentTimeMillis()
        assertTrue(installer.downloadApk(abcSha, "http://unused.invalid/x.apk"))
        assertTrue(OtaInstaller.busy)
        assertTrue(OtaInstaller.isBusy(t0 + OtaInstaller.BUSY_MAX_MS - 1_000))
        assertFalse(OtaInstaller.isBusy(t0 + OtaInstaller.BUSY_MAX_MS + 1_000))
    }
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests 'ai.lanka.kiosk.OtaInstallerTest' --console=plain 2>&1 | tail -8
```

Expected: compilation failure — `Unresolved reference: clearBusy` / `packageNameMatches`.

- [ ] **Step 3: Implement `busy` and the guard in `OtaInstaller.kt`**

Rename the existing `fun downloadApk(sha256: String, url: String): Boolean { … }` to `private fun downloadInner(sha256: String, url: String): Boolean { … }` (body unchanged) and add above it:

```kotlin
    /**
     * Marks the box busy for the whole OTA (download → install → OS result). A
     * surface switch restarts the player Activity, which would orphan a half-done
     * OTA; SurfaceSwitcher refuses while [busy]. Cleared on every failure path
     * here, on the immediate-failure paths of [installSilently], and by
     * OtaInstallReceiver when the OS reports the result. A successful install
     * kills the process anyway. Age-capped at [BUSY_MAX_MS] so a wedged OTA (the
     * WebView died between download and install, the result broadcast never
     * came) can never block the rollback path for good.
     */
    fun downloadApk(sha256: String, url: String): Boolean {
        busySince = System.currentTimeMillis()
        val ok = runCatching { downloadInner(sha256, url) }.getOrDefault(false)
        if (!ok) clearBusy()
        return ok
    }
```

Replace the whole `installSilently(context, sha256, commandId, onImmediateFailure)` overload (keep its KDoc and the `WebView` overload above it) with:

```kotlin
    fun installSilently(
        context: Context,
        sha256: String,
        commandId: Long,
        onImmediateFailure: (status: String) -> Unit,
    ) {
        fun fail(status: String) { clearBusy(); onImmediateFailure(status) }

        val apk = apkFile(sha256)
        // Re-verify at the point of install (not just at download): refuse to commit
        // any cached file whose bytes don't hash to the expected sha. This closes the
        // stale/pre-fix-cache gap — bad bytes are un-installable regardless of how
        // they reached apk-cache.
        if (!cachedFileIsValid(sha256)) {
            apk.delete()
            Log.w(TAG, "OTA cache for $sha256 missing or hash-mismatched — refusing install")
            fail("failed")
            return
        }

        // Defense-in-depth: a device-owner install bypasses the OS same-signer
        // check, so refuse an APK signed by a different key than the running app.
        // Fail OPEN only when signatures are unreadable on this ROM (don't brick
        // OTA — the bytes were already SHA-verified at download); fail CLOSED on a
        // positive signer mismatch.
        val selfSigners = runCatching { installedSigners(context) }.getOrDefault(emptySet())
        val archiveSigners = runCatching { archiveSigners(context, apk.absolutePath) }.getOrDefault(emptySet())
        if (selfSigners.isNotEmpty() && archiveSigners.isNotEmpty() &&
            !signaturesMatch(selfSigners, archiveSigners)
        ) {
            Log.e(TAG, "OTA signer mismatch — refusing install of $sha256")
            fail("failed")
            return
        }

        // Refuse an archive that would install a DIFFERENT package — e.g. a stale
        // `ai.lanka.kiosk.vs` release from before the single-APK merge. A
        // device-owner install of a foreign package would put a second kiosk on the
        // box. Fail CLOSED: an archive whose package name can't be read is not
        // installed either (the SHA proves integrity, not identity).
        val archivePkg = runCatching {
            context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)?.packageName
        }.getOrNull()
        if (!packageNameMatches(context.packageName, archivePkg)) {
            Log.e(TAG, "OTA package mismatch: archive=$archivePkg self=${context.packageName} — refusing install")
            fail("failed")
            return
        }

        // Everything session-related inside ONE try so createSession/openSession
        // failures also reach fail() — otherwise busy would stay set.
        var session: PackageInstaller.Session? = null
        try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+: an app holding REQUEST_INSTALL_PACKAGES may update
                // *itself* (same signer) with no prompt. A device-owner install is
                // silent regardless; this also covers the non-owner self-update path
                // on certified boxes. If the box still refuses, the commit reports
                // STATUS_PENDING_USER_ACTION and OtaInstallReceiver falls back to the
                // system install prompt.
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val sessionId = installer.createSession(params)
            val s = installer.openSession(sessionId)
            session = s
            s.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            val intent = Intent(context, OtaInstallReceiver::class.java).apply {
                putExtra(OtaInstallReceiver.EXTRA_COMMAND_ID, commandId)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, commandId.toInt(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            s.commit(pendingIntent.intentSender)
        } catch (e: Exception) {
            runCatching { session?.abandon() }
            Log.e(TAG, "installSilently failed: ${e.message}")
            fail("failed")
        } finally {
            runCatching { session?.close() } // release our handle; a committed session is the OS's now
        }
    }
```

In the `companion object` add:

```kotlin
        /**
         * Epoch ms when the current OTA started; 0 when idle. See [downloadApk].
         * Read through [busy] / [isBusy] so a wedged OTA expires after [BUSY_MAX_MS].
         */
        @Volatile private var busySince: Long = 0L
        const val BUSY_MAX_MS = 15 * 60_000L

        fun isBusy(now: Long = System.currentTimeMillis()): Boolean =
            busySince != 0L && now - busySince < BUSY_MAX_MS

        val busy: Boolean get() = isBusy()

        fun clearBusy() { busySince = 0L }

        /** Fail CLOSED: a foreign OR unreadable package name is refused. */
        internal fun packageNameMatches(self: String, archive: String?): Boolean =
            archive == self
```

- [ ] **Step 4: Clear `busy` in `OtaInstallReceiver.onReceive`**

First line of `onReceive` body, before reading the extras:

```kotlin
        OtaInstaller.clearBusy() // the OTA is over, whatever the outcome (incl. the user-action prompt)
```

- [ ] **Step 5: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests 'ai.lanka.kiosk.OtaInstallerTest' --console=plain 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`, all `OtaInstallerTest` tests pass (the pre-existing ones too).

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstaller.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstallReceiver.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt
git commit -m "feat(kiosk): OtaInstaller busy flag + refuse foreign-package archives

busy spans download → install → OS result (age-capped at 15 min) so a
surface switch can refuse while an OTA is in flight without ever being
blocked for good. installSilently rejects an APK whose package name is not
ours or unreadable (a stale .vs release would install a second kiosk).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `SurfaceSwitcher`

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/SurfaceSwitcher.kt`

**Interfaces:**
- Consumes: `SurfaceKind.parse`, `SurfaceStore.requestSwitch`, `OtaInstaller.busy`.
- Produces: `SurfaceSwitcher.request(activity: Activity, name: String): String?` — null = accepted; `SurfaceSwitcher.ACK_GRACE_MS = 500L`.

- [ ] **Step 1: Write it**

```kotlin
package ai.lanka.kiosk

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The `set-surface` command, shared by both surfaces (NativeFSBridge.setSurface
 * for the WebView player, CommandActions.setSurface for the native one).
 *
 * Validate → commit the preference → recreate() the host Activity after a short
 * grace. The grace lets the ack frame leave the socket that the current surface
 * owns before that surface is torn down. Thread-safe: called from the JavaBridge
 * thread or the WebSocket thread; recreate() itself always runs on main.
 */
object SurfaceSwitcher {
    const val ACK_GRACE_MS = 500L
    private const val TAG = "LankaKiosk"
    private val main = Handler(Looper.getMainLooper())

    /** The one scheduled restart. A newer request replaces it, so back-to-back
     *  toggles end in a single recreate() that reads the final committed value
     *  (recreate() is asynchronous — isFinishing/isDestroyed alone would not
     *  stop a second call on the same instance). */
    private var pendingRestart: Runnable? = null

    /** Null when accepted (including "already on that surface"); else the failure reason. */
    fun request(activity: Activity, name: String): String? {
        val target = SurfaceKind.parse(name) ?: return "unknown surface '$name'"
        if (OtaInstaller.busy) return "ota in progress"
        if (!SurfaceStore(activity).requestSwitch(target)) {
            Log.i(TAG, "set-surface ${target.wire}: already active")
            return null
        }
        Log.i(TAG, "set-surface ${target.wire}: committed, restarting player in ${ACK_GRACE_MS}ms")
        scheduleRestart(activity)
        return null
    }

    @Synchronized
    private fun scheduleRestart(activity: Activity) {
        pendingRestart?.let { main.removeCallbacks(it) }
        val task = Runnable {
            synchronized(this) { pendingRestart = null }
            if (!activity.isFinishing && !activity.isDestroyed) activity.recreate()
        }
        pendingRestart = task
        main.postDelayed(task, ACK_GRACE_MS)
    }
}
```

- [ ] **Step 2: Build**

```bash
cd android && ./gradlew :app:assembleDebug --console=plain 2>&1 | tail -3
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/SurfaceSwitcher.kt
git commit -m "feat(kiosk): SurfaceSwitcher — validate, commit, delayed recreate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `set-surface` in the native command dispatcher

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/player/CommandDispatcher.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/PlayerActivity.kt` (transitional override; the file is replaced in Task 6)
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/player/CommandDispatcherTest.kt`

**Interfaces:**
- Produces: `CommandActions.setSurface(name: String): String?` (null = accepted, else reason). Dispatcher acks `acked` / `failed <reason>` / `failed missing surface`.

- [ ] **Step 1: Write the failing tests**

In `CommandDispatcherTest.kt`, extend `FakeActions`:

```kotlin
private class FakeActions : CommandActions {
    var rebooted = false; var locked: Boolean? = null; var ota: Triple<String, String, Int>? = null; var reloaded = false
    var surfaceRequested: String? = null; var surfaceReason: String? = null
    override fun reboot(): Boolean { rebooted = true; return true }
    override fun screenshot() = "data:image/png;base64,AAAA"
    override fun getLogs() = "log-line-1"
    override fun setKioskLock(enabled: Boolean) { locked = enabled }
    override fun installOta(sha256: String, url: String, commandId: Int): Boolean { ota = Triple(sha256, url, commandId); return true }
    override fun reload() { reloaded = true }
    override fun setSurface(name: String): String? { surfaceRequested = name; return surfaceReason }
}
```

and add tests:

```kotlin
    @Test fun `set-surface acks when the action accepts`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":8,"cmd":"set-surface","payload":{"surface":"native"}}""")
        assertEquals("native", a.surfaceRequested)
        assertTrue(s.sent.single().contains("\"commandId\":8"))
        assertTrue(s.sent.single().contains("\"status\":\"acked\""))
    }
    @Test fun `set-surface fails with the action's reason`() {
        val a = FakeActions().apply { surfaceReason = "ota in progress" }; val s = FakeSender()
        CommandDispatcher(a, s).handle("""{"commandId":9,"cmd":"set-surface","payload":{"surface":"native"}}""")
        assertTrue(s.sent.single().contains("\"status\":\"failed\""))
        assertTrue(s.sent.single().contains("ota in progress"))
    }
    @Test fun `set-surface without a surface fails`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":10,"cmd":"set-surface","payload":{}}""")
        assertEquals(null, a.surfaceRequested)
        assertTrue(s.sent.single().contains("\"status\":\"failed\""))
        assertTrue(s.sent.single().contains("missing surface"))
    }
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests 'ai.lanka.kiosk.player.CommandDispatcherTest' --console=plain 2>&1 | tail -8
```

Expected: compilation failure — `'setSurface' overrides nothing`.

- [ ] **Step 3: Implement**

In `CommandDispatcher.kt`, add to `interface CommandActions`:

```kotlin
    /** `set-surface`: switch the player surface ("webview" | "native"). Null = accepted, else the reason. */
    fun setSurface(name: String): String?
```

Add a branch in `handle`'s `when (type)`, before `else ->`:

```kotlin
            "set-surface" -> {
                val surface = payload?.get("surface")?.jsonPrimitive?.contentOrNull
                if (surface.isNullOrBlank()) {
                    ack(commandId, "failed", "missing surface")
                    return
                }
                // Ack BEFORE the surface restarts: SurfaceSwitcher delays recreate()
                // by ACK_GRACE_MS so this frame leaves the socket first.
                val reason = runCatching { actions.setSurface(surface) }.getOrElse { it.toString() }
                if (reason == null) ack(commandId, "acked") else ack(commandId, "failed", reason)
            }
```

- [ ] **Step 4: Keep `PlayerActivity` compiling until Task 6 replaces it**

`PlayerActivity.commandActions` implements `CommandActions`, so the new abstract member breaks it. Add this override inside its `commandActions` object (after `setKioskLock`):

```kotlin
        override fun setSurface(name: String): String? = SurfaceSwitcher.request(this@PlayerActivity, name)
```

- [ ] **Step 5: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests 'ai.lanka.kiosk.player.CommandDispatcherTest' --console=plain 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`, 11 tests pass.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/player/CommandDispatcher.kt \
        android/app/src/test/kotlin/ai/lanka/kiosk/player/CommandDispatcherTest.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/PlayerActivity.kt
git commit -m "feat(kiosk): set-surface command in the native CommandDispatcher

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `NativeSurface` (from `PlayerActivity`)

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt`
- Delete: `android/app/src/main/kotlin/ai/lanka/kiosk/PlayerActivity.kt`

**Interfaces:**
- Consumes: `PlayerSurface`, `SurfaceSwitcher` (through the `switchSurface` lambda), `CommandActions.setSurface`.
- Produces: `class NativeSurface(activity: Activity, root: FrameLayout, onConfirmed: () -> Unit, switchSurface: (String) -> String?) : PlayerSurface`; `NativeSurface.PLAYER_VERSION = "native-1"`.

- [ ] **Step 1: Check nothing else references `PlayerActivity`**

```bash
grep -rn "PlayerActivity" android/app/src --include='*.kt' --include='*.xml' | grep -v "PlayerActivity.kt"
```

Expected: no output. (If a test references `PlayerActivity.PLAYER_VERSION`, change it to `NativeSurface.PLAYER_VERSION`.)

- [ ] **Step 2: Write `NativeSurface.kt`**

This is `PlayerActivity` with `this` → `activity`, `root` injected, `mainHandler` → own `handler`, `runOnUiThread` → `onUi` (dropped after `stop()`), `onManifest` also confirming health, and a full `stop()`.

```kotlin
package ai.lanka.kiosk

import ai.lanka.kiosk.player.AndroidSchedulerDeps
import ai.lanka.kiosk.player.CommandActions
import ai.lanka.kiosk.player.CommandClient
import ai.lanka.kiosk.player.Manifest
import ai.lanka.kiosk.player.ManifestClient
import ai.lanka.kiosk.player.OkHttpTelemetryPoster
import ai.lanka.kiosk.player.PlaybackView
import ai.lanka.kiosk.player.Scheduler
import ai.lanka.kiosk.player.TelemetryClient
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.util.UnstableApi
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Native (ExoPlayer) player surface — the body of the pre-merge PlayerActivity,
 * hosted by [MainActivity]. The analogue of the web player's `usePlayerBoot`.
 *
 * Wires together: [ManifestClient] (register / SSE / 30s poll / prefetch),
 * [Scheduler] (timing) + [PlaybackView] (ExoPlayer A/B crossfade) per manifest,
 * [TelemetryClient] (item-start / item-failed / cleared), and one [CommandClient]
 * (reboot / screenshot / logs / kiosk-lock / OTA / reload / set-surface).
 *
 * View lifecycle: [root] holds exactly one visible child at a time — a
 * [standbyView] (before the first manifest, or on a boot-time error with
 * nothing yet played), a [noContentView] (manifest cleared / 204), or the
 * current [PlaybackView]. Each manifest releases the prior PlaybackView +
 * Scheduler and builds fresh ones, matching the web player's `:key` remount.
 *
 * Health: the first manifest callback (any manifest, even empty — it proves
 * we registered and the server talks to us) calls [onConfirmed], which the
 * crash-loop guard uses to mark this surface last-known-good.
 */
@UnstableApi
class NativeSurface(
    private val activity: Activity,
    private val root: FrameLayout,
    private val onConfirmed: () -> Unit,
    private val switchSurface: (String) -> String?,
) : PlayerSurface {

    private val handler = Handler(Looper.getMainLooper())

    private lateinit var standbyView: View
    private lateinit var noContentView: View

    private lateinit var deviceId: String
    private lateinit var http: OkHttpClient
    private lateinit var json: Json
    private lateinit var mediaCache: MediaCache
    private lateinit var telemetry: TelemetryClient

    private var manifestClient: ManifestClient? = null
    private var commandClient: CommandClient? = null

    private var playbackView: PlaybackView? = null
    private var scheduler: Scheduler? = null

    /** True once we have shown real content (a manifest), so a later transient
     *  error doesn't blank an already-playing screen back to standby. */
    private var hasPlayed = false

    @Volatile private var stopped = false

    // Network calls (register/reconcile) must not run on the UI thread.
    private val bootIo = Executors.newSingleThreadExecutor { r ->
        Thread(r, "player-boot").apply { isDaemon = true }
    }

    override fun start() {
        deviceId = DeviceId.get(activity)

        // Shared client keeps FINITE timeouts. ManifestClient derives its own
        // infinite-read SSE client from this; ExoPlayer/telemetry use it directly.
        http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        json = Json { ignoreUnknownKeys = true }
        mediaCache = MediaCache.get(activity)

        standbyView = makeBanner("Lanka — waiting for content…")
        noContentView = makeBanner("No content scheduled")
        showStandbyIfNeverPlayed()

        telemetry = TelemetryClient(
            OkHttpTelemetryPoster(http, BuildConfig.LANKA_SERVER_URL),
            BuildConfig.VERSION_NAME
        )

        // Native streams media via the server `/media/:sha` proxy (mediaPublicBase
        // = ""); prefetch downloads everything, so this only falls back on a miss.
        val mc = ManifestClient(
            deviceId = deviceId,
            serverBaseUrl = BuildConfig.LANKA_SERVER_URL,
            mediaPublicBase = "",
            http = http,
            json = json,
            mediaCache = mediaCache,
            onManifest = { m -> onUi { onConfirmed(); onManifest(m) } },
            onError = { onUi { showStandbyIfNeverPlayed() } },
            onReload = { onUi { activity.recreate() } },
            onCommandSecret = { DeviceSecretStore.put(activity, deviceId, it) }
        )
        manifestClient = mc

        // Register + start network off the UI thread (NetworkOnMainThread-safe).
        // stop() can land mid-boot (a switch while registering): shutdownNow()
        // only interrupts, and an OkHttp call in flight runs to completion, so
        // re-check between stages — otherwise we would reopen SSE/polling after
        // close(), and startPolling() on the shut-down executor would throw on
        // this thread, which on Android crashes the process.
        bootIo.execute {
            try {
                mc.register("native", PLAYER_VERSION)
                if (stopped) return@execute
                mc.reconcile()
                if (stopped) return@execute
                mc.openStream()
                if (stopped) return@execute
                mc.startPolling()
            } catch (e: Exception) {
                if (!stopped) Log.w(TAG, "native boot failed: $e")
            }
        }

        commandClient = CommandClient(
            deviceId,
            BuildConfig.LANKA_SERVER_URL,
            http,
            commandActions,
            // Stored from a prior register (TOFU). Null on the very first boot —
            // the WS connects in grace until register persists it for next time.
            secret = DeviceSecretStore.get(activity, deviceId)
        ).also { it.open() }
    }

    /** Hop to the UI thread; dropped once stopped (a callback can land after teardown). */
    private fun onUi(block: () -> Unit) {
        activity.runOnUiThread { if (!stopped) block() }
    }

    /** Always on the UI thread. Tear down the previous playlist and mount the new
     *  one (or the no-content view when the manifest is null/empty). */
    private fun onManifest(m: Manifest?) {
        playbackView?.let { pv ->
            root.removeView(pv)
            pv.release()
        }
        playbackView = null
        scheduler?.stop()
        scheduler = null

        if (m == null || m.items.isEmpty()) {
            showOnly(noContentView)
            telemetry.clearedCurrent(deviceId)
            return
        }

        val sched = Scheduler(m.items, AndroidSchedulerDeps(handler))
        val pv = PlaybackView(
            activity,
            mediaCache,
            fileUrlResolver = { sha ->
                if (mediaCache.exists(sha)) Uri.fromFile(mediaCache.file(sha))
                else Uri.parse("${BuildConfig.LANKA_SERVER_URL}/media/$sha")
            },
            onItemStarted = { id -> telemetry.itemStarted(deviceId, id) },
            onItemFailed = { id, sha, msg -> telemetry.itemFailed(deviceId, id, sha, msg) },
            onCleared = { telemetry.clearedCurrent(deviceId) }
        )
        scheduler = sched
        playbackView = pv
        root.addView(pv, matchParent())
        showOnly(pv)
        hasPlayed = true
        pv.bind(m, sched)
    }

    private fun showStandbyIfNeverPlayed() {
        if (!hasPlayed) showOnly(standbyView)
    }

    /** Make [view] the sole visible child of [root]. */
    private fun showOnly(view: View) {
        if (view.parent == null) root.addView(view, matchParent())
        for (i in 0 until root.childCount) {
            val child = root.getChildAt(i)
            child.visibility = if (child === view) View.VISIBLE else View.GONE
        }
    }

    private fun makeBanner(text: String): View = TextView(activity).apply {
        this.text = text
        setTextColor(Color.parseColor("#F4F4F5"))
        setBackgroundColor(Color.BLACK)
        gravity = Gravity.CENTER
        visibility = View.GONE
    }

    // ── Command channel actions (native analogue of NativeFSBridge) ──────────

    private val commandActions = object : CommandActions {
        override fun reboot(): Boolean = DevicePolicy.reboot(activity)

        override fun reload() {
            onUi { activity.recreate() }
        }

        override fun setKioskLock(enabled: Boolean) {
            KioskLock.locked = enabled
            Log.i(TAG, "kiosk lock set to $enabled")
        }

        override fun setSurface(name: String): String? = switchSurface(name)

        /** Capture the player window into a JPEG data URI. Mirrors
         *  NativeFSBridge.screenshot() but draws the player root (no WebView). */
        override fun screenshot(): String = captureScreenshot()

        /** Last 200 logcat lines filtered to Lanka tags (same as NativeFSBridge). */
        override fun getLogs(): String = try {
            val proc = Runtime.getRuntime().exec(
                arrayOf(
                    "logcat", "-d", "-t", "200", "-s",
                    "LankaKiosk:*", "LankaCache:*", "NativeFS:*",
                    "OtaInstaller:*", "CommandClient:*", TAG
                )
            )
            proc.inputStream.bufferedReader().readText()
        } catch (e: Exception) {
            "error: ${e.message}"
        }

        /** Download + silently install the OTA APK. The OS-delivered result (or an
         *  immediate failure) flows back via OtaResultBus → CommandClient's ack. */
        override fun installOta(sha256: String, url: String, commandId: Int): Boolean {
            val absUrl = if (url.startsWith("http")) url
                         else BuildConfig.LANKA_SERVER_URL.trimEnd('/') + url
            val installer = OtaInstaller.get(activity)
            if (!installer.downloadApk(sha256, absUrl)) return false
            installer.installSilently(activity, sha256, commandId.toLong()) { status ->
                OtaResultBus.notify(commandId.toLong(), status)
            }
            return true
        }
    }

    /** Draw the player root into a bitmap on the UI thread and JPEG-encode it as
     *  a data URI. Software-canvas draw (like the WebView path) so it works
     *  without a Surface handle. Empty string on failure. */
    private fun captureScreenshot(): String {
        val latch = CountDownLatch(1)
        var result = ""
        activity.runOnUiThread {
            try {
                val w = root.width.coerceAtLeast(1)
                val h = root.height.coerceAtLeast(1)
                val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(bitmap))
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
                result = "data:image/jpeg;base64," +
                    Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            } catch (e: Exception) {
                Log.w(TAG, "screenshot failed: ${e.message}")
            } finally {
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    /** Ownership rule: everything start() created goes here. Idempotent. */
    override fun stop() {
        if (stopped) return
        stopped = true
        manifestClient?.close()
        manifestClient = null
        commandClient?.close()            // also clears the OtaResultBus listener
        commandClient = null
        playbackView?.let { root.removeView(it); it.release() }
        playbackView = null
        scheduler?.stop()
        scheduler = null
        bootIo.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        if (::standbyView.isInitialized) root.removeView(standbyView)
        if (::noContentView.isInitialized) root.removeView(noContentView)
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
    )

    companion object {
        private const val TAG = "LankaKiosk"
        const val PLAYER_VERSION = "native-1"
    }
}
```

- [ ] **Step 3: Delete `PlayerActivity.kt` and build**

```bash
git rm -q android/app/src/main/kotlin/ai/lanka/kiosk/PlayerActivity.kt
cd android && ./gradlew :app:assembleDebug test --console=plain 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/NativeSurface.kt
git commit -m "refactor(android): PlayerActivity → NativeSurface (PlayerSurface impl)

Same ExoPlayer player body, hosted by MainActivity instead of being its own
Activity. First manifest confirms surface health; stop() releases everything.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `WebViewSurface`, `NativeFSBridge.setSurface`, and the `MainActivity` host — the swap goes live

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/WebViewSurface.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt` (rewrite)
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt` (`onPageOk` only on a clean main-frame load)
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt` (add `onDestroy`)
- Delete: `android/app/src/main/res/layout/activity_main.xml`

**Interfaces:**
- Consumes: `PlayerSurface`, `SurfaceStore`, `SurfaceSwitcher.request`, `NativeSurface`.
- Produces: `class WebViewSurface(activity, container, onConfirmed: () -> Unit, onStartFailed: () -> Unit, switchSurface) : PlayerSurface`; `NativeFSBridge(…, switchSurface: (String) -> String? = { "not supported" })` with `@JavascriptInterface fun setSurface(name: String): String` (`""` = ok); `LankaWebViewClient.onPageOk` fires only when the navigation had no main-frame error (network or HTTP ≥ 400).

- [ ] **Step 1: Add `setSurface` to `NativeFSBridge`**

Add a constructor parameter after `currentUrl`:

```kotlin
    /** `set-surface` handler (SurfaceSwitcher.request bound to the host Activity). Null = accepted. */
    private val switchSurface: (String) -> String? = { "not supported" }
```

Add the method after `setKioskLock`:

```kotlin
    /**
     * Switches the player surface ("webview" | "native"). The choice is committed
     * to SharedPreferences and the host Activity is recreated after a short grace,
     * so the JS caller can still send its ack. Returns "" on success, else the
     * failure reason (the dashboard shows it verbatim).
     */
    @JavascriptInterface
    fun setSurface(name: String): String {
        if (!privilegedOriginAllowed()) return "forbidden"
        val reason = switchSurface(name)
        Log.i(TAG, "set-surface $name → ${reason ?: "accepted"}")
        return reason ?: ""
    }
```

- [ ] **Step 2: Make `LankaWebViewClient.onPageOk` mean "clean load"**

Today `onPageFinished` fires even after a main-frame error (and for an HTTP 4xx/5xx document), so `onPageOk` would confirm a broken surface as healthy — and, incidentally, reset the reload backoff to 3 s on every failed attempt. Track failure per navigation. In `LankaWebViewClient.kt`:

Add a field after `currentUrl`:

```kotlin
    /** Set by a main-frame network or HTTP (≥400) error during the current navigation;
     *  reset on the next onPageStarted. onPageOk fires only when it is clear. */
    private var mainFrameFailed = false
```

Replace `onPageStarted`, `onPageFinished` and `onReceivedError`, and add `onReceivedHttpError`:

```kotlin
    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        mainFrameFailed = false
        currentUrl = url
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        currentUrl = url
        if (!mainFrameFailed) onPageOk()
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?
    ) {
        Log.e("LankaWebView", "load error ${error?.errorCode} ${error?.description} — ${request?.url}")
        // Only retry on the top-level document; a single failed media subresource
        // must not trigger a full page reload.
        if (request?.isForMainFrame == true) {
            mainFrameFailed = true
            onMainFrameError()
        }
    }

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        errorResponse: WebResourceResponse?
    ) {
        // A 4xx/5xx DOCUMENT (server mid-deploy, nginx 502) is not a healthy
        // player either: back off and retry like a network error.
        if (request?.isForMainFrame == true && (errorResponse?.statusCode ?: 0) >= 400) {
            Log.e("LankaWebView", "main-frame HTTP ${errorResponse?.statusCode} — ${request.url}")
            mainFrameFailed = true
            onMainFrameError()
        }
    }
```

Update the class KDoc's second bullet to: `a load that finished without a main-frame error calls [onPageOk] so the host can reset its retry backoff (and confirm the surface healthy);`.

- [ ] **Step 3: Write `WebViewSurface.kt`**

```kotlin
package ai.lanka.kiosk

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * WebView player surface — the body of the pre-merge MainActivity, hosted by
 * [MainActivity]. Loads `/player?deviceId=…` and exposes `window.NativeFS`;
 * the Nuxt page is the player (reconciler, scheduler, telemetry, command WS).
 *
 * Health: a CLEAN main-frame load ([LankaWebViewClient.onPageOk]) calls
 * [onConfirmed]. A renderer death BEFORE that first clean load calls
 * [onStartFailed] instead of plain recreate(): a recreate() is not a cold
 * start for the crash-loop guard, so without this a freshly switched box whose
 * WebView renderer can't survive the initial load would loop forever.
 */
class WebViewSurface(
    private val activity: Activity,
    private val container: FrameLayout,
    private val onConfirmed: () -> Unit,
    private val onStartFailed: () -> Unit,
    private val switchSurface: (String) -> String?,
) : PlayerSurface {

    private val handler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private lateinit var playerUrl: String

    private var reloadAttempt = 0
    private var reloadPending = false
    private var confirmed = false
    private var stopped = false

    override fun start() {
        val wv = WebView(activity)
        webView = wv
        container.addView(
            wv,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        configure(wv)

        OtaResultBus.setListener { commandId, status ->
            handler.post { webView?.evaluateJavascript("window.__otaResult($commandId, '$status')", null) }
        }

        playerUrl = "${BuildConfig.LANKA_SERVER_URL}/player?deviceId=${DeviceId.get(activity)}"
        wv.loadUrl(playerUrl)
    }

    private fun configure(wv: WebView) {
        wv.setBackgroundColor(Color.BLACK)
        // Create the client first: it tracks the current top-level URL, which the
        // NativeFS bridge reads to gate privileged calls to the trusted origin.
        val client = LankaWebViewClient(
            onMainFrameError = { scheduleReload() },
            onPageOk = { reloadAttempt = 0; confirmed = true; onConfirmed() },
            onRenderGone = { recoverFromRenderGone() },
            mediaCache = MediaCache.get(activity),
            trustedOrigin = BuildConfig.LANKA_SERVER_URL
        )
        wv.webViewClient = client
        wv.addJavascriptInterface(
            NativeFSBridge(
                MediaCache.get(activity), activity, wv,
                trustedOrigin = BuildConfig.LANKA_SERVER_URL,
                currentUrl = { client.currentUrl },
                switchSurface = switchSurface
            ),
            "NativeFS"
        )
        wv.webChromeClient = LankaChromeClient()
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString LankaKiosk/${BuildConfig.VERSION_NAME}"
        }
    }

    /**
     * The main player document failed to load — server or tailnet not ready at
     * boot, or a transient drop. Retry with capped exponential backoff so the
     * box heals itself instead of sitting on a blank page until someone visits.
     * Reset on a successful load via [LankaWebViewClient.onPageFinished].
     */
    private fun scheduleReload() {
        if (reloadPending || stopped) return
        reloadPending = true
        val delayMs = minOf(RELOAD_BASE_MS shl reloadAttempt, RELOAD_MAX_MS)
        if (reloadAttempt < RELOAD_MAX_SHIFT) reloadAttempt++
        handler.postDelayed({
            reloadPending = false
            webView?.loadUrl(playerUrl)
        }, delayMs)
    }

    /**
     * The WebView renderer process died (OOM, GPU/codec crash — common during
     * hours of video on low-end boxes). Without handling this, the OS kills the
     * Activity and the screen stays black. Tear down the dead WebView and rebuild
     * the host Activity so the kiosk recovers on its own.
     *
     * Before the first clean page load this is a START failure (the host reverts
     * a pending switch, then restarts either way); after it, the ordinary
     * mid-run recovery the WebView kiosk always had.
     */
    private fun recoverFromRenderGone() {
        stop()
        if (confirmed) activity.recreate() else onStartFailed()
    }

    /** Ownership rule: everything start() created goes here. Idempotent. */
    override fun stop() {
        if (stopped) return
        stopped = true
        OtaResultBus.clearListener()
        handler.removeCallbacksAndMessages(null)
        reloadPending = false
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
    }

    companion object {
        private const val RELOAD_BASE_MS = 3_000L  // first retry after 3s
        private const val RELOAD_MAX_MS = 30_000L  // cap between retries
        private const val RELOAD_MAX_SHIFT = 4     // 3,6,12,24 → then 30s cap
    }
}
```

- [ ] **Step 4: Rewrite `MainActivity.kt`**

Replace the whole file with:

```kotlin
package ai.lanka.kiosk

import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi

/**
 * The ONE launcher component (`ai.lanka.kiosk/.MainActivity`). Hosts whichever
 * [PlayerSurface] the box is set to — [WebViewSurface] or [NativeSurface] —
 * and applies the crash-loop guard ([SurfaceStore]). Boot, the device-owner
 * HOME pin, lock task, the snap-back watchdog and the PIN pad (all in
 * [KioskActivity] / [DevicePolicy]) never see the difference.
 *
 * A surface switch is `SurfaceStore.requestSwitch` + `recreate()`: onDestroy
 * stops the old surface, onCreate reads the new choice and starts it.
 */
class MainActivity : KioskActivity() {

    private lateinit var store: SurfaceStore
    private var surface: PlayerSurface? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        // Device-owner kiosk lockdown (lock-task whitelist, HOME launcher,
        // keyguard/status-bar off, deferred OS updates). No-op when Lanka is not
        // provisioned as device owner, so the same APK still runs anywhere.
        DevicePolicy.applyKioskPolicies(this, MainActivity::class.java)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)

        store = SurfaceStore(this)
        // Cold start (new process) vs recreate() is decided by SurfaceStore via
        // ProcessToken — that is how the guard tells a crash loop from a switch.
        val kind = store.onActivityCreate()
        Log.i(TAG, "starting ${kind.wire} surface")

        // Assign BEFORE start(): a surface that throws halfway through start()
        // still owns whatever it created, and only stop() can release it.
        val candidate = createSurface(kind, root)
        surface = candidate
        try {
            candidate.start()
        } catch (e: Exception) {
            Log.e(TAG, "${kind.wire} surface failed to start: $e")
            candidate.stop()
            surface = null
            if (store.startFailed()) {
                recreate() // reverted → come back up on the last-known-good surface
            } else {
                // Nothing to fall back to. Never loop on a synchronous failure:
                // show a banner and wait — same as a crash, but visible.
                root.addView(TextView(this).apply {
                    text = "Lanka — player failed to start"
                    setTextColor(Color.parseColor("#F4F4F5"))
                    gravity = Gravity.CENTER
                })
            }
        }
    }

    @OptIn(UnstableApi::class) // NativeSurface is built on Media3's unstable API
    private fun createSurface(kind: SurfaceKind, root: FrameLayout): PlayerSurface {
        val switch: (String) -> String? = { SurfaceSwitcher.request(this, it) }
        return when (kind) {
            SurfaceKind.WEBVIEW -> WebViewSurface(
                this, root,
                onConfirmed = store::confirm,
                onStartFailed = ::handleStartFailure,
                switchSurface = switch
            )
            SurfaceKind.NATIVE -> NativeSurface(this, root, onConfirmed = store::confirm, switchSurface = switch)
        }
    }

    /**
     * A surface gave up before confirming health (WebView renderer died during
     * the initial load). Revert a pending switch if there is one, then restart
     * either way — the renderer-recovery behaviour the kiosk always had. Not a
     * tight loop: renderer deaths are spaced by the WebView's own startup.
     */
    private fun handleStartFailure() {
        store.startFailed()
        recreate()
    }

    override fun onDestroy() {
        surface?.stop()
        surface = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "LankaKiosk"
    }
}
```

- [ ] **Step 5: Move the handler cleanup into `KioskActivity`**

The two old Activities cleared the shared `mainHandler` in their `onDestroy`; the surfaces now own their own handlers, so `KioskActivity` clears its own. Add to `KioskActivity` after `onPause`:

```kotlin
    override fun onDestroy() {
        // The snap-back and PIN-pad idle posts are ours; drop them so a destroyed
        // instance never re-foregrounds itself. Surfaces own and clear their own Handler.
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
```

- [ ] **Step 6: Delete the unused layout and build**

```bash
git rm -q android/app/src/main/res/layout/activity_main.xml
grep -rn "activity_main\|PlayerActivity" android/app/src ; # expect no output
cd android && ./gradlew :app:assembleDebug test --console=plain 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 7: (Optional) Smoke on a box**

If a box is reachable over ADB wireless:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.lanka.kiosk/.MainActivity
adb logcat -d -s LankaKiosk:* | tail -5     # expect "starting webview surface"
```

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/kotlin/ai/lanka/kiosk/WebViewSurface.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt \
        android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt
git commit -m "feat(kiosk): MainActivity hosts a runtime-selected PlayerSurface

WebViewSurface (ex-MainActivity body) and NativeSurface are picked from
SurfaceStore at onCreate; set-surface (NativeFS.setSurface / native
CommandActions) commits the choice and recreate()s. Crash-loop guard wired;
onPageOk now means a clean main-frame load; a renderer death before the
first clean load counts as a start failure.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Server — `set-surface` command type and validated enqueue body

**Files:**
- Modify: `server/services/command-hub.ts:6`
- Modify: `server/db/schema.ts` (`deviceCommands.cmd` enum)
- Modify: `server/api/devices/[id]/commands.post.ts`
- Modify: `app/types/api.ts` (`DeviceCommand.cmd`)
- Modify: `app/composables/useApiClient.ts` (`enqueueCommand` body)
- Test: `tests/api/device-commands.test.ts`

**Interfaces:**
- Produces: `CommandType` includes `'set-surface'`; `handleEnqueueCommand(db, hub, deviceId, rawInput: unknown)` — `{ cmd: 'set-surface', surface: 'webview' | 'native' }` → payload `{ surface }`; 400 on a missing/unknown surface or unknown cmd.

- [ ] **Step 1: Write the failing tests**

Add `import { eq } from 'drizzle-orm'` to `tests/api/device-commands.test.ts` and these cases inside the `describe`:

```ts
  it('enqueue set-surface stores the surface in the payload', async () => {
    const result = await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface', surface: 'native' })
    const [row] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, result.commandId))
    expect(row.cmd).toBe('set-surface')
    expect(JSON.parse(row.payload!)).toEqual({ surface: 'native' })
  })

  it('enqueue set-surface 400s without a surface', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('enqueue 400s on an unknown surface', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface', surface: 'desktop' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('enqueue 400s on an unknown cmd', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'self-destruct' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('delivers set-surface with its payload to a connected peer', async () => {
    const sent: string[] = []
    hub.register('dev-1', { send: (m) => sent.push(m) })
    await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'set-surface', surface: 'webview' })
    expect(JSON.parse(sent[0])).toMatchObject({ cmd: 'set-surface', payload: { surface: 'webview' } })
  })
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run tests/api/device-commands.test.ts 2>&1 | tail -15
```

Expected: the three new 400 tests and the payload test fail (today the body is unvalidated: `set-surface` is inserted with a null payload; unknown cmds are inserted too).

- [ ] **Step 3: Implement**

`server/services/command-hub.ts` line 6:

```ts
export type CommandType = 'ota' | 'reboot' | 'screenshot' | 'log-request' | 'kiosk-lock' | 'kiosk-unlock' | 'set-surface'
```

`server/db/schema.ts` — in `deviceCommands`, the `cmd` column (type-only; the column has no SQL CHECK, so **no migration**):

```ts
    cmd: text('cmd', { enum: ['ota', 'reboot', 'screenshot', 'log-request', 'kiosk-lock', 'kiosk-unlock', 'set-surface'] }).notNull(),
```

`server/api/devices/[id]/commands.post.ts` — replace the imports/`EnqueueInput`/`handleEnqueueCommand` head with:

```ts
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useCommandHub } from '~/server/services/command-hub'

const COMMAND_TYPES = ['ota', 'reboot', 'screenshot', 'log-request', 'kiosk-lock', 'kiosk-unlock', 'set-surface'] as const

// Validated here, not trusted from the dashboard: a typo'd surface must never
// reach a box (the APK would refuse it, but the operator would only see "failed").
const EnqueueSchema = z.object({
  cmd: z.enum(COMMAND_TYPES),
  releaseId: z.number().int().positive().optional(),
  surface: z.enum(['webview', 'native']).optional()
})

export type EnqueueInput = z.infer<typeof EnqueueSchema>

export async function handleEnqueueCommand(
  db: BetterSQLite3Database<typeof schema>,
  hub: ReturnType<typeof useCommandHub>,
  deviceId: string,
  rawInput: unknown
): Promise<{ commandId: number }> {
  const parsed = EnqueueSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: `invalid command: ${parsed.error.issues[0]?.message ?? 'bad body'}` })
  }
  const input = parsed.data

  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!device) throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })

  let payload: Record<string, unknown> | null = null
  if (input.cmd === 'ota') {
    if (!input.releaseId) throw createError({ statusCode: 400, message: 'releaseId required for ota command' })
    const [release] = await db
      .select()
      .from(schema.apkReleases)
      .where(eq(schema.apkReleases.id, input.releaseId))
    if (!release) throw createError({ statusCode: 404, message: 'APK release not found' })
    payload = {
      releaseId: release.id,
      version: release.version,
      sha256: release.sha256,
      url: `/api/apk/${release.id}/download`
    }
  }
  if (input.cmd === 'set-surface') {
    if (!input.surface) throw createError({ statusCode: 400, message: 'surface required for set-surface command' })
    payload = { surface: input.surface }
  }

  const commandId = await hub.enqueue(db, deviceId, input.cmd, payload)
  return { commandId }
}
```

(`handleListCommands` and the `defineEventHandler` stay as they are.)

`app/types/api.ts` — `DeviceCommand.cmd`:

```ts
  cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request' | 'kiosk-lock' | 'kiosk-unlock' | 'set-surface'
```

`app/composables/useApiClient.ts` line 133:

```ts
  enqueueCommand(deviceId: string, body: { cmd: string; releaseId?: number; surface?: 'webview' | 'native' }): Promise<{ commandId: number }>
```

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run tests/api/device-commands.test.ts 2>&1 | tail -5
```

Expected: all pass (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/command-hub.ts server/db/schema.ts 'server/api/devices/[id]/commands.post.ts' \
        app/types/api.ts app/composables/useApiClient.ts tests/api/device-commands.test.ts
git commit -m "feat(api): set-surface device command + validated enqueue body

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Web player — report `surface: 'webview'` and handle `set-surface`

**Files:**
- Modify: `app/composables/player/useNativeDevice.ts` (add `PLAYER_SURFACE`)
- Modify: `app/composables/player/usePlayerBoot.ts:105-116`
- Modify: `app/composables/player/useTelemetry.ts`
- Modify: `app/composables/player/useReconciler.ts` (`NativeFSBridge` type)
- Modify: `app/composables/player/useCommandChannel.ts`
- Modify: `app/composables/useApiClient.ts` (`register` / `postTelemetry` body types)
- Test: `tests/player/useTelemetry.test.ts` (new), `tests/player/useCommandChannel.test.ts`

**Interfaces:**
- Consumes: `NativeFS.setSurface(name): string` from Task 7 (`""` = ok).
- Produces: `PLAYER_SURFACE = 'webview'`; register + telemetry bodies carry `surface: 'webview'`; `NativeFSBridge.setSurface?(name: string): string`.

- [ ] **Step 1: Write the failing tests**

`tests/player/useTelemetry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { useTelemetry } from '~/app/composables/player/useTelemetry'

describe('useTelemetry', () => {
  it('reports surface: webview on every post', () => {
    const api = { postTelemetry: vi.fn(() => Promise.resolve()) } as any
    const t = useTelemetry(api)

    t.itemStarted('dev-1', 7)
    expect(api.postTelemetry).toHaveBeenCalledWith(
      'dev-1',
      expect.objectContaining({ currentItemId: 7, surface: 'webview' })
    )

    t.clearedCurrent('dev-1')
    expect(api.postTelemetry).toHaveBeenLastCalledWith(
      'dev-1',
      expect.objectContaining({ currentItemId: null, surface: 'webview' })
    )

    t.itemFailed('dev-1', 7, 'abc', 'boom')
    expect(api.postTelemetry).toHaveBeenLastCalledWith(
      'dev-1',
      expect.objectContaining({ surface: 'webview', error: { sha256: 'abc', message: 'boom' } })
    )
  })
})
```

In `tests/player/useCommandChannel.test.ts`, add `setSurface: vi.fn(() => '')` to `makeNativeFS()` and these cases inside the `describe`:

```ts
  it('set-surface calls NativeFS.setSurface and acks on an empty result', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open(); ws.open()
    ws.receive({ commandId: 20, cmd: 'set-surface', payload: { surface: 'native' } })
    expect(nativeFS.setSurface).toHaveBeenCalledWith('native')
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 20, status: 'acked' })
    ch.close()
  })

  it('set-surface fails with the reason the bridge returns', () => {
    nativeFS.setSurface = vi.fn(() => 'ota in progress')
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open(); ws.open()
    ws.receive({ commandId: 21, cmd: 'set-surface', payload: { surface: 'native' } })
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 21, status: 'failed', result: 'ota in progress' })
    ch.close()
  })

  it('set-surface fails without a surface in the payload', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open(); ws.open()
    ws.receive({ commandId: 22, cmd: 'set-surface', payload: {} })
    expect(nativeFS.setSurface).not.toHaveBeenCalled()
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 22, status: 'failed', result: 'missing surface' })
    ch.close()
  })

  it('set-surface is not supported on a bridge without setSurface (old APK)', () => {
    const legacy = { ...nativeFS } as any
    delete legacy.setSurface
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS: legacy, onReload: () => {}, wsFactory })
    ch.open(); ws.open()
    ws.receive({ commandId: 23, cmd: 'set-surface', payload: { surface: 'native' } })
    expect(JSON.parse(ws.sent[0])).toMatchObject({ commandId: 23, status: 'failed', result: 'not supported' })
    ch.close()
  })
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run tests/player/useTelemetry.test.ts tests/player/useCommandChannel.test.ts 2>&1 | tail -15
```

Expected: the telemetry test fails (no `surface` in the body); the first set-surface test fails (`setSurface` not called — today an unknown cmd is silently ignored, so `ws.sent[0]` is undefined).

- [ ] **Step 3: Implement**

`app/composables/player/useNativeDevice.ts` — after `export const PLAYER_VERSION = '3.0.0-web'`:

```ts
/**
 * What this (web) player reports as its surface. Sent on register and every
 * telemetry post so `devices.surface` flips back after a native→webview switch
 * on the same device row (the column default alone would leave it on 'native').
 */
export const PLAYER_SURFACE = 'webview' as const
```

`app/composables/player/usePlayerBoot.ts` — import `PLAYER_SURFACE` alongside `PLAYER_VERSION` and in `ensureRegistered`:

```ts
      const res = await api.register({
        deviceId: deviceId.value,
        playerVersion: PLAYER_VERSION,
        surface: PLAYER_SURFACE
      })
```

`app/composables/player/useTelemetry.ts` — add `import { PLAYER_SURFACE } from './useNativeDevice'` and change the post in `fire`:

```ts
    api.postTelemetry(deviceId, {
      ...body,
      surface: PLAYER_SURFACE,
      ...(apkVersion ? { apkVersion } : {})
    }).catch((err) => {
      console.warn('[player] telemetry post failed', err)
    })
```

`app/composables/useApiClient.ts` — body types:

```ts
  register(body: {
    deviceId: string
    playerVersion: string
    surface?: 'webview' | 'native'
  }): Promise<RegisterResult>
  getManifest(deviceId: string): Promise<Manifest | null>
  postTelemetry(
    deviceId: string,
    body: {
      currentItemId: number | null
      apkVersion?: string
      surface?: 'webview' | 'native'
      error?: { sha256?: string; message: string }
    }
  ): Promise<void>
```

`app/composables/player/useReconciler.ts` — in `interface NativeFSBridge`, after `reboot?(): boolean`'s doc block (keep `setKioskLock` as is) add:

```ts
  /**
   * Switches the player surface ("webview" | "native"). Returns "" when the
   * switch was accepted (the APK restarts the player shortly after), else the
   * failure reason. Absent on APKs older than 0.3.0-surface.
   */
  setSurface?(name: string): string
```

`app/composables/player/useCommandChannel.ts` — `Command.cmd` union gains `'set-surface'`; in `handleCommand`, after the `if (!nfs) { … }` block, add:

```ts
    if (type === 'set-surface') {
      const surface = (payload as Record<string, unknown> | null)?.surface
      if (typeof surface !== 'string' || !surface) {
        send({ commandId, status: 'failed', result: 'missing surface' })
        return
      }
      if (!nfs.setSurface) {
        send({ commandId, status: 'failed', result: 'not supported' })
        return
      }
      try {
        // The APK commits the choice synchronously and recreates the Activity
        // ~500 ms later, so this ack still leaves the socket.
        const reason = nfs.setSurface(surface)
        if (reason) send({ commandId, status: 'failed', result: reason })
        else send({ commandId, status: 'acked' })
      }
      catch (e) {
        send({ commandId, status: 'failed', result: String(e) })
      }
      return
    }
```

- [ ] **Step 4: Run the tests, then the full suite**

```bash
pnpm vitest run tests/player 2>&1 | tail -5
pnpm test 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add app/composables/player/useNativeDevice.ts app/composables/player/usePlayerBoot.ts \
        app/composables/player/useTelemetry.ts app/composables/player/useReconciler.ts \
        app/composables/player/useCommandChannel.ts app/composables/useApiClient.ts \
        tests/player/useTelemetry.test.ts tests/player/useCommandChannel.test.ts
git commit -m "feat(player): report surface=webview; handle set-surface via NativeFS

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Drop `apk_releases.flavor`

**Files:**
- Modify: `server/db/schema.ts` (`apkReleases`)
- Create: `server/db/migrations/0013_<drizzle-name>.sql` + `meta/` updates (generated)
- Modify: `server/api/apk/upload.post.ts`
- Test: `tests/api/apk-upload.test.ts`

**Interfaces:**
- Produces: `apkReleases` has no `flavor`; `UploadApkInput` has no `flavor`; `parseApkFlavor` / `ApkFlavor` no longer exist.

- [ ] **Step 1: Rewrite the tests**

Replace the whole of `tests/api/apk-upload.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleUploadApk } from '~/server/api/apk/upload.post'
import * as schema from '~/server/db/schema'
import { eq } from 'drizzle-orm'

const fakeStore = {
  put: async (_sha: string, _s: Readable) => {},
  has: async (_sha: string) => false,
  delete: async (_sha: string) => {},
  stat: async (_sha: string) => ({ bytes: 3 }),
  open: async (_sha: string) => Readable.from(Buffer.from([1, 2, 3])),
  putThumbnail: async () => {},
  hasThumbnail: async () => false,
  openThumbnail: async () => Readable.from(Buffer.from('')),
  deleteThumbnail: async () => {}
}

describe('handleUploadApk', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('persists version, sha256 and size — and no flavor (one APK serves both surfaces)', async () => {
    const row = await handleUploadApk(db, fakeStore, {
      sha256: 'a'.repeat(64),
      version: '0.3.0-surface',
      size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])),
      uploadedBy: null
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r).toMatchObject({ version: '0.3.0-surface', sha256: 'a'.repeat(64), size: 3 })
    expect(r).not.toHaveProperty('flavor')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run tests/api/apk-upload.test.ts 2>&1 | tail -8
```

Expected: FAIL — `expected … not to have property "flavor"`.

- [ ] **Step 3: Remove the column and generate the migration**

In `server/db/schema.ts`, delete the line `flavor: text('flavor').notNull().default('webview')` from `apkReleases` (and the trailing comma on the line above it so the object stays valid). Then:

```bash
pnpm db:generate 2>&1 | tail -5
ls server/db/migrations | tail -2
cat server/db/migrations/0013_*.sql
```

Expected: a new `0013_<name>.sql` plus updated `meta/_journal.json` + `meta/0013_snapshot.json`. Drizzle emits either `ALTER TABLE \`apk_releases\` DROP COLUMN \`flavor\`;` (SQLite ≥ 3.35; better-sqlite3 bundles a newer one) or a table recreate (`PRAGMA foreign_keys=OFF … CREATE TABLE __new_apk_releases … INSERT INTO … DROP TABLE … ALTER TABLE … RENAME`). Both are fine **provided** the full `pnpm test` in Step 5 passes — `createTestDb` runs the whole migrations folder on every DB test, which is the real check that the migration applies and keeps `sha256`'s UNIQUE constraint and the `uploaded_by` FK. Do not hand-edit the generated SQL.

- [ ] **Step 4: Remove flavor handling from `upload.post.ts`**

Delete `APK_FLAVORS`, `ApkFlavor`, `parseApkFlavor` and the `flavor?: ApkFlavor` field of `UploadApkInput`; in `handleUploadApk` drop `...(input.flavor ? { flavor: input.flavor } : {})`; in the event handler delete the two `flavorRaw` / `flavor` lines and the `flavor` property passed to `handleUploadApk`. The resulting insert is:

```ts
  const [row] = await db
    .insert(schema.apkReleases)
    .values({
      version: input.version,
      sha256: input.sha256,
      size: input.size,
      uploadedBy: input.uploadedBy
    })
    .returning()
```

- [ ] **Step 5: Run the tests + full suite**

```bash
grep -rn "flavor" server app tests --include='*.ts' --include='*.vue' ; # expect no output
pnpm vitest run tests/api/apk-upload.test.ts tests/api/apk.test.ts 2>&1 | tail -5
pnpm test 2>&1 | tail -5
```

Expected: green. (`createTestDb` applies the migrations folder, so the new migration is exercised by every DB test.)

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/migrations server/api/apk/upload.post.ts tests/api/apk-upload.test.ts
git commit -m "feat(api): drop apk_releases.flavor — one APK serves both surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Dashboard — the surface switch control

**Files:**
- Create: `app/utils/surfaceSwitch.ts`
- Test: `tests/utils/surfaceSwitch.test.ts`
- Modify: `app/pages/devices/[id].vue` (script ~lines 126-220, template ~lines 343-366)

**Interfaces:**
- Consumes: `DeviceCommand` (Task 8), `status.surface`, `api.enqueueCommand(id, { cmd: 'set-surface', surface })`.
- Produces: `surfaceSwitchView(commands: DeviceCommand[], reported: SurfaceName | null, now: number): SurfaceSwitchView` with `phase: 'idle' | 'queued' | 'sent' | 'applying' | 'failed'`, `requested: SurfaceName | null`, `reason: string | null`; `APPLYING_WINDOW_MS = 3 * 60_000`.

- [ ] **Step 1: Write the failing test**

`tests/utils/surfaceSwitch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { surfaceSwitchView, APPLYING_WINDOW_MS } from '~/app/utils/surfaceSwitch'
import type { DeviceCommand } from '~/app/types/api'

const now = 1_700_000_000_000

function cmd(partial: Partial<DeviceCommand> & Pick<DeviceCommand, 'id' | 'cmd' | 'status'>): DeviceCommand {
  return {
    deviceId: 'dev-1',
    payload: null,
    result: null,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    ...partial
  }
}

describe('surfaceSwitchView', () => {
  it('is idle with no set-surface command', () => {
    expect(surfaceSwitchView([cmd({ id: 1, cmd: 'screenshot', status: 'acked' })], 'webview', now))
      .toEqual({ phase: 'idle', requested: null, reason: null })
  })

  it('uses the NEWEST set-surface row (list is newest first)', () => {
    const v = surfaceSwitchView([
      cmd({ id: 3, cmd: 'set-surface', status: 'pending', payload: '{"surface":"native"}' }),
      cmd({ id: 2, cmd: 'set-surface', status: 'acked', payload: '{"surface":"webview"}' })
    ], 'webview', now)
    expect(v).toEqual({ phase: 'queued', requested: 'native', reason: null })
  })

  it('shows sent while the box has not acked', () => {
    const v = surfaceSwitchView([cmd({ id: 1, cmd: 'set-surface', status: 'sent', payload: '{"surface":"native"}' })], 'webview', now)
    expect(v.phase).toBe('sent')
  })

  it('shows applying after an ack until telemetry reports the new surface', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'acked', payload: '{"surface":"native"}', updatedAt: now - 30_000 })
    expect(surfaceSwitchView([row], 'webview', now).phase).toBe('applying')
    expect(surfaceSwitchView([row], 'native', now).phase).toBe('idle')
  })

  it('gives up on applying after the window', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'acked', payload: '{"surface":"native"}', updatedAt: now - APPLYING_WINDOW_MS - 1 })
    expect(surfaceSwitchView([row], 'webview', now).phase).toBe('idle')
  })

  it('surfaces the failure reason', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'failed', payload: '{"surface":"native"}', result: 'ota in progress' })
    expect(surfaceSwitchView([row], 'webview', now)).toEqual({ phase: 'failed', requested: 'native', reason: 'ota in progress' })
  })

  it('tolerates a malformed payload', () => {
    const row = cmd({ id: 1, cmd: 'set-surface', status: 'acked', payload: 'not json' })
    expect(surfaceSwitchView([row], 'webview', now)).toEqual({ phase: 'idle', requested: null, reason: null })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run tests/utils/surfaceSwitch.test.ts 2>&1 | tail -5
```

Expected: FAIL — cannot resolve `~/app/utils/surfaceSwitch`.

- [ ] **Step 3: Write `app/utils/surfaceSwitch.ts`**

(`app/utils` is NOT a Nuxt auto-import dir in this project — `srcDir` is `.`; import it explicitly.)

```ts
import type { DeviceCommand } from '~/app/types/api'

export type SurfaceName = 'webview' | 'native'

export interface SurfaceSwitchView {
  /** What the control shows. `idle` = nothing in flight. */
  phase: 'idle' | 'queued' | 'sent' | 'applying' | 'failed'
  /** The surface the operator last asked for (from the newest set-surface row). */
  requested: SurfaceName | null
  /** The box's failure reason when `phase === 'failed'`. */
  reason: string | null
}

/** After an ack, how long we keep saying "applying…" while the reported surface still differs. */
export const APPLYING_WINDOW_MS = 3 * 60_000

function parseSurface(payload: string | null): SurfaceName | null {
  if (!payload) return null
  try {
    const s = (JSON.parse(payload) as { surface?: unknown }).surface
    return s === 'webview' || s === 'native' ? s : null
  } catch {
    return null
  }
}

/**
 * Derives the switch control's state from the device's command list (newest
 * first, as `GET /api/devices/:id/commands` returns it) and the reported
 * surface. The server stores no "desired surface": the newest `set-surface`
 * row IS the request, `devices.surface` (telemetry) is the truth.
 */
export function surfaceSwitchView(
  commands: DeviceCommand[],
  reported: SurfaceName | null,
  now: number
): SurfaceSwitchView {
  const idle: SurfaceSwitchView = { phase: 'idle', requested: null, reason: null }
  const latest = commands.find((c) => c.cmd === 'set-surface')
  if (!latest) return idle
  const requested = parseSurface(latest.payload)
  if (!requested) return idle

  switch (latest.status) {
    case 'pending':
      return { phase: 'queued', requested, reason: null }
    case 'sent':
      return { phase: 'sent', requested, reason: null }
    case 'failed':
      return { phase: 'failed', requested, reason: latest.result }
    case 'acked': {
      const age = now - new Date(latest.updatedAt).getTime()
      const applying = reported !== requested && age >= 0 && age < APPLYING_WINDOW_MS
      return applying ? { phase: 'applying', requested, reason: null } : idle
    }
    default:
      return idle
  }
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run tests/utils/surfaceSwitch.test.ts 2>&1 | tail -5
```

Expected: 7 passed.

- [ ] **Step 5: Wire the control into the device page**

In `app/pages/devices/[id].vue` `<script setup>`:

Add to the imports at the top:

```ts
import { surfaceSwitchView, type SurfaceName } from '~/app/utils/surfaceSwitch'
```

Change `enqueue`'s signature:

```ts
async function enqueue(cmd: string, extra?: { releaseId?: number; surface?: SurfaceName }) {
```

After `function confirmOta() { … }` add:

```ts
// ── Player surface (set-surface) ────────────────────────────────────────────
// Unknown/loading must not read as "WebView": status arrives a beat after the page.
const surfaceLabel = (s: SurfaceName | null | undefined) =>
  s === 'native' ? 'Native' : s === 'webview' ? 'WebView' : '—'
const otherSurface = computed<SurfaceName>(() => (status.value?.surface === 'native' ? 'webview' : 'native'))
// Re-evaluated on every 10 s command poll / 5 s status poll (both replace the refs).
const surfaceSwitch = computed(() =>
  surfaceSwitchView(commands.value, (status.value?.surface as SurfaceName | undefined) ?? null, Date.now())
)
const surfaceSwitchInFlight = computed(() =>
  surfaceSwitch.value.phase === 'queued' || surfaceSwitch.value.phase === 'sent'
)

async function confirmSurfaceSwitch() {
  const target = otherSurface.value
  const ok = await confirm({
    title: `Switch player to ${surfaceLabel(target)}?`,
    description: 'The player restarts on the box. Rollback is switching back — no OTA.',
    confirmLabel: 'Switch'
  })
  if (ok) enqueue('set-surface', { surface: target })
}
```

In `confirmReboot`, make the copy surface-neutral:

```ts
    description: 'The player will restart on the box.',
```

In the template, replace the `<UBadge …>{{ … 'Native' : 'WebView' }}</UBadge>` inside the "APK version + OTA" row with nothing (remove those three lines), and insert this new row **before** `<!-- APK version + OTA -->`:

```vue
          <!-- Player surface (runtime-selectable; one APK carries both) -->
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm text-(--ui-text-muted)">Player surface:</span>
            <UBadge :color="status?.surface === 'native' ? 'primary' : 'neutral'" variant="subtle" size="sm">
              {{ surfaceLabel(status?.surface) }}
            </UBadge>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-arrow-left-right"
              :disabled="commandPending || surfaceSwitchInFlight"
              :loading="commandPending"
              @click="confirmSurfaceSwitch"
            >Switch to {{ surfaceLabel(otherSurface) }}</UButton>
            <span v-if="surfaceSwitchInFlight" class="text-xs text-(--ui-text-muted)">
              Switching to {{ surfaceLabel(surfaceSwitch.requested) }}… ({{ surfaceSwitch.phase }})
            </span>
            <span v-else-if="surfaceSwitch.phase === 'applying'" class="text-xs text-(--ui-text-muted)">
              Applying {{ surfaceLabel(surfaceSwitch.requested) }}… (waiting for the box to report back)
            </span>
            <span v-else-if="surfaceSwitch.phase === 'failed'" class="text-xs text-(--ui-text-error)">
              Switch to {{ surfaceLabel(surfaceSwitch.requested) }} failed: {{ surfaceSwitch.reason ?? 'unknown' }}
            </span>
          </div>

```

- [ ] **Step 6: Build the app**

```bash
pnpm build 2>&1 | tail -5
```

Expected: build succeeds. (If the dev server is up on `:5100`, open a device page and confirm the row renders: badge + "Switch to Native" button.)

- [ ] **Step 7: Commit**

```bash
git add app/utils/surfaceSwitch.ts tests/utils/surfaceSwitch.test.ts 'app/pages/devices/[id].vue'
git commit -m "feat(dashboard): player-surface switch control on the device page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Docs, runbook, and memory

**Files:**
- Modify: `CLAUDE.md` (Android sections, Testing section)
- Modify: `android/README.md` (Build section, PIN section, the `.vs` mentions)
- Modify: `README.md` (only if it mentions flavors — `grep -n "assembleWebview\|assembleNative\|kiosk.vs\|flavor" README.md`; today it does not)

- [ ] **Step 1: `CLAUDE.md`**

In "## Android kiosk player (APK)", first bullet: replace the sentence `**The app is now flavored** — there is no plain `assembleDebug`; use `assembleWebviewDebug` or `assembleNativeDebug` (see "Native player flavor" below).` with:

```
One APK, one package — `./gradlew :app:assembleDebug -PLANKA_SERVER_URL=… [-PKIOSK_PIN=…]`; APK at `app/build/outputs/apk/debug/app-debug.apk`. Both player surfaces ship in it (see "Runtime player surface" below).
```

In the "On-device PIN escape hatch" bullet, replace `All of it lives in `src/main` so both flavors share one implementation.` with `All of it lives in `KioskActivity`, shared by both player surfaces.`

Third bullet (ADB): replace `adb install -r android/app/build/outputs/apk/webview/debug/app-webview-debug.apk` with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` and delete the parenthetical `(Native flavor: … PlayerActivity.)`.

Replace the whole "## Native player flavor (Lanka-vs / ExoPlayer)" section with:

```markdown
## Runtime player surface (WebView ⇄ native ExoPlayer)

The APK carries **two player surfaces** and picks one at runtime (merged 2026-08-23; spec/plan: `docs/superpowers/{specs,plans}/2026-08-23-single-apk-runtime-surface*`). There is **one launcher component, `ai.lanka.kiosk/.MainActivity`** — it hosts a `PlayerSurface`: `WebViewSurface` (the WebView kiosk loading `/player`, with `NativeFSBridge`) or `NativeSurface` (ExoPlayer/Media3; Kotlin owns manifest/SSE/telemetry/command-WS in `player/*.kt`, a 1:1 port of the web composables). Boot, the device-owner HOME pin, lock task, snap-back and the PIN pad live in `KioskActivity`/`DevicePolicy` and never see the difference.

- **Switching** = dashboard device page → "Switch to Native/WebView" → `set-surface {surface}` command. The box commits the choice (`SharedPreferences lanka_kiosk`, key `surface`; absent → `webview`) via `SurfaceSwitcher`, **acks, then `recreate()`s 500 ms later** (one debounced restart per toggle burst). Rollback = switch back; no OTA. Refused with `ota in progress` while `OtaInstaller.busy` (download → install → OS result, age-capped at 15 min so a wedged OTA can never block the rollback path).
- **Crash-loop guard** (`SurfacePolicy`, pure, JVM-tested; `SurfaceStore` = prefs adapter): a switch is *pending* until the surface confirms health (WebView: a **clean** main-frame load — `LankaWebViewClient.onPageOk` no longer fires after a main-frame network/HTTP≥400 error; native: first manifest). 3 **cold** process starts within 10 min of a pending switch, a synchronous start failure, or a WebView renderer death before the first clean load, revert to `lastGood`. Cold start = a **new OS process**, detected by `ProcessToken` vs the stored `surface.process` key — a `recreate()` (switch, renderer recovery, native `reload`) is not one. Window expiry stops guarding (no revert — a server outage must not flip a healthy box). `MainActivity.onCreate` is the only caller; `SurfaceStore` serializes on one process-wide lock.
- **Ownership rule:** everything a surface's `start()` creates, its idempotent `stop()` releases (views, WebView/ExoPlayer, sockets, SSE, executors, Handler posts, `OtaResultBus` listener). Each surface owns its own `Handler`; `KioskActivity.onDestroy` clears only its own.
- **Reported vs requested:** `devices.surface` is what the box last reported (the web player now sends `surface: 'webview'` on register + telemetry; native sends `native`). The server stores no desired state — the newest `set-surface` command row is the request; `app/utils/surfaceSwitch.ts` derives the control's queued/sent/applying/failed state.
- **OTA guard:** `OtaInstaller.installSilently` refuses an archive whose package name ≠ `ai.lanka.kiosk` **or is unreadable** (fail closed; a stale `-vs` release from the flavor era would otherwise install a second kiosk). `apk_releases.flavor` was dropped.
- Native plays cached files directly via `Uri.fromFile(MediaCache.file(sha))`; the WebView path uses the `shouldInterceptRequest` cache. **Images must be pre-cached** for native (no network fallback in the ImageView path).
- Unit tests: `./gradlew test` (single variant; the former `src/testNative` suites now live in `src/test/kotlin/ai/lanka/kiosk/player/`). `media3`/`okhttp`/`kotlinx-serialization` are plain `implementation` deps (~6 MB APK).
```

In "## Testing", replace the Android bullet with:

```
- **Android:** `./gradlew test` (in `android/`) runs the JVM unit tests (one variant). Pure cores (`SurfacePolicy`, `KioskPin`, `TapChord`, `player/*`) are tested; Activity/surface/bridge code is build-verified.
```

Check nothing else in `CLAUDE.md` references the flavors:

```bash
grep -n "assembleWebview\|assembleNative\|testNative\|kiosk.vs\|Lanka-vs\|PlayerActivity" CLAUDE.md ; # expect no output
```

- [ ] **Step 2: `android/README.md`**

Replace the "## Build" section body (from `The app is **flavored**` through the `APKs land at …` line) with:

```markdown
One APK, one package (`ai.lanka.kiosk`). Both player surfaces — the WebView
kiosk and the native ExoPlayer player — ship in it; which one runs is chosen
per box from the dashboard (device page → *Switch to Native / WebView*), stored
on the box, and survives reboot. Rollback is switching back; no OTA.

```bash
cd android
./gradlew :app:assembleDebug -PLANKA_SERVER_URL=http://lanka-server:3000
```

The server URL is **compile-time** (`BuildConfig.LANKA_SERVER_URL`); rebuild to
retarget (no on-device override). Use a Tailscale MagicDNS name
(`http://lanka-server:3000`) or a raw `100.x.y.z` IP your TVs can reach over the
tailnet.

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`.
```

Rewrite "### Native dev + prod builds (helper)" as:

```markdown
### Dev + prod builds (helper)

`scripts/build-apk.sh` builds the APK for the dev and/or prod server in one
step (URLs overridable via `LANKA_DEV_URL` / `LANKA_PROD_URL`; set
`LANKA_KIOSK_PIN` to bake the PIN escape hatch):

```bash
scripts/build-apk.sh        # both → app-debug-{DEV,PROD}.apk
scripts/build-apk.sh prod   # prod only
```

Defaults: dev = `http://100.123.113.86:5100` (local dev server on the tailnet),
prod = `http://100.79.177.86` (Hetzner, nginx tailnet block on :80). Both share
`applicationId ai.lanka.kiosk`, so only one can be installed on a box at a time.
```

In "## On-device PIN escape hatch", change `./gradlew :app:assembleNativeDebug \` to `./gradlew :app:assembleDebug \`.

Append a new section before "## Release build (signed)":

```markdown
## Migrating a box from the two-flavor era (`ai.lanka.kiosk.vs`)

The former native flavor was a separate package. A box that still has it
needs it removed, or both kiosks fight for the foreground:

1. On the APK page of the dashboard, **delete every old `-vs` release** before
   pushing anything (the APK also refuses a foreign package name, but don't rely on it).
2. `adb shell dumpsys device_policy | grep -i owner`
   - `.vs` is **not** the device owner → `adb uninstall ai.lanka.kiosk.vs`.
   - `.vs` **is** the device owner → it cannot be uninstalled and
     `dpm remove-active-admin` only works for `android:testOnly` builds:
     factory-reset the box and re-provision with `ai.lanka.kiosk` (above).
3. Delete the now-offline `.vs` device row on the Devices page (different
   `deviceId`; nothing adopts it).
4. OTA the fleet to `0.3.0-surface` or newer. Every box keeps its package,
   `deviceId`, HOME pin and device-owner status and boots the WebView surface
   (no preference stored). Then switch per box from the dashboard.

Verify on one box: switch → badge flips within a minute → reboot → still the
new surface → PIN pad still unlocks → switch back. Pushing an OTA and
switching mid-download must fail with `ota in progress`.
```

```bash
grep -n "assembleWebview\|assembleNative\|testNative\|Lanka-vs\|PlayerActivity\|build-native-apk" android/README.md README.md ; # expect no output (kiosk.vs only in the migration section)
```

- [ ] **Step 3: Full gates**

```bash
pnpm test 2>&1 | tail -3
pnpm build 2>&1 | tail -3
cd android && ./gradlew test :app:assembleDebug --console=plain 2>&1 | tail -3
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md android/README.md README.md
git commit -m "docs(kiosk): single APK + runtime surface — CLAUDE.md, android/README, migration runbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:** build/layout → T1; `PlayerSurface` + `SurfaceKind` + policy + store (+ `ProcessToken`) → T2; `OtaInstaller.busy` (age-capped) + fail-closed package guard → T3; debounced switcher → T4; native `set-surface` (+ transitional `PlayerActivity` override) → T5; `NativeSurface` with guarded boot → T6; `WebViewSurface` (`onStartFailed`), `LankaWebViewClient` clean-load semantics, `NativeFSBridge.setSurface`, `MainActivity` host (assign-then-start, `@OptIn`), `KioskActivity.onDestroy` → T7; server command type + zod → T8; web player reports surface + `useCommandChannel` → T9; drop `flavor` → T10; dashboard control (incl. surface-neutral restart copy, `—` for unknown) → T11; runbook + docs → T12. Non-goals untouched.

**Revised after Codex review (2026-08-23):** partial-start leak (assign before `start()`), process-wide `SurfaceStore` lock, debounced `recreate()`, guarded native boot (an unguarded `startPolling()` on the shut-down executor would crash the process), mandatory transitional override instead of a conditional compile fix, unconditional `@OptIn`, `onPageOk` only on a clean load, renderer death before confirmation = start failure, `ProcessToken` instead of `savedInstanceState` as the cold-start signal, `busy` wrapping all session failures + 15-min age cap, fail-closed package guard, deterministic download-failure test, `surfaceLabel(null) = '—'`, migration accepted only via the test suite, memory update removed from the plan (done by the operating session, not a task worker). Declined: an `AtomicBoolean` refusing overlapping OTAs (both call paths are single-threaded; a refusal would drop an operator's retry after a wedged first attempt — the age cap covers that case).

**Type consistency:** `SurfaceKind.parse/wire`; `SurfaceStore.requestSwitch(target): Boolean`, `onActivityCreate(): SurfaceKind`, `confirm()`, `startFailed(): Boolean`; `SurfaceSwitcher.request(activity, name): String?`; `OtaInstaller.busy/isBusy(now)/clearBusy()/BUSY_MAX_MS`; `CommandActions.setSurface(name): String?`; `WebViewSurface(activity, container, onConfirmed, onStartFailed, switchSurface)`; `NativeSurface(activity, root, onConfirmed, switchSurface)`; `NativeFSBridge.setSurface(name): String` (`""` ok); TS `setSurface?(name): string`; `surfaceSwitchView(commands, reported, now)` — used identically across tasks.

**Placeholders:** none; every code step is complete and no step is conditional on a build outcome.
