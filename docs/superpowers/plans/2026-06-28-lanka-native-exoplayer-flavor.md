# Lanka-vs — Native ExoPlayer Player Flavor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, fully-native Android player flavor (`native` → `ai.lanka.kiosk.vs`, "Lanka-vs") that renders video with ExoPlayer/Media3 and owns its playback logic in Kotlin, alongside the unchanged WebView APK, reusing the existing server control plane.

**Architecture:** One `android/` Gradle project gains a `surface` flavor dimension (`webview` default, `native`). WebView-specific Kotlin moves to a `src/webview` source set; a new `src/native` source set holds Kotlin ports of the player orchestration (reconciler/scheduler/telemetry/command-WS) plus an ExoPlayer A/B `PlaybackView`. Shared kiosk/OTA/cache code stays in `src/main`. The server gains an additive `surface` column so the dashboard can distinguish the two players.

**Tech Stack:** Kotlin, AndroidX Media3 (ExoPlayer) `1.3.1`, OkHttp `4.12.0` (+ `okhttp-sse`), kotlinx.serialization, JUnit4 (JVM unit tests). Server: Nuxt 4 / Nitro, Drizzle ORM, better-sqlite3, Vitest, zod.

## Global Constraints

- **minSdk 24, compileSdk/targetSdk 34** — unchanged; all new deps support API 24.
- **`native` flavor:** `applicationIdSuffix = ".vs"` (→ `ai.lanka.kiosk.vs`), `versionNameSuffix = "-vs"`. Both flavors honor the existing `-PLANKA_SERVER_URL` Gradle property.
- **WebView flavor behavior is preserved** — `webview` is the default flavor; its runtime behavior must not change (verified by `assembleWebviewDebug` + existing `./gradlew test`).
- **Media stays WebView-safe** — transcoding (H.264 Main/Baseline, yuv420p, ≤720p) is unchanged and still mandatory; native boxes play that same media. Do NOT relax the transcode profile in this plan.
- **`devices.surface`** is `text` NOT NULL DEFAULT `'webview'`; native clients report `surface: "native"`. The WebView APK never sends `surface` (stays default).
- **ExoPlayer plays cached local files directly** — `Uri.fromFile(...)`; the native flavor does NOT use `MediaCache.intercept`/Range/sniff.
- **New native deps are scoped** to the `native` flavor via `nativeImplementation(...)` so the WebView APK does not grow.
- **TDD, DRY, YAGNI, frequent commits.** Pure Kotlin ports are test-first against the existing vitest cases as the spec.
- **Box verification uses a production server build** (`pnpm build` + `node .output/server/index.mjs`), never `pnpm dev`.
- Server port for any manual server run: `PORT=5100`.

---

## Phase 1 — Server: `surface` reporting (additive, TDD)

### Task 1: `devices.surface` column + `register` accepts `surface`

**Files:**
- Modify: `server/db/schema.ts` (devices table, after `apkVersion`)
- Generate: `server/db/migrations/<nnnn>_*.sql` (via `pnpm db:generate`)
- Modify: `server/api/devices/register.post.ts:7-13` (BodySchema), `:30-44` (upsert)
- Test: `tests/api/devices-register.test.ts`

**Interfaces:**
- Produces: `RegisterBody` gains optional `surface?: 'webview' | 'native'`; `devices.surface` column (default `'webview'`).

- [ ] **Step 1: Add the column to the schema**

In `server/db/schema.ts`, in the `devices` table, add after the `apkVersion: text('apk_version')` line (add a comma to that line):

```ts
  apkVersion: text('apk_version'),
  // Which player renders on this device: the WebView APK ('webview', default)
  // or the native ExoPlayer APK ('native'). Reported on register/telemetry.
  surface: text('surface').notNull().default('webview')
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `server/db/migrations/` containing `ALTER TABLE \`devices\` ADD \`surface\` text DEFAULT 'webview' NOT NULL;`. Apply it with `pnpm db:migrate`.

- [ ] **Step 3: Write the failing test**

In `tests/api/devices-register.test.ts`, add:

```ts
it('persists surface when provided', async () => {
  await handleRegister(db, { deviceId: 'dev-vs', playerVersion: '0.1.0', surface: 'native' })
  const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-vs'))
  expect(row.surface).toBe('native')
})

it('defaults surface to webview when omitted', async () => {
  await handleRegister(db, { deviceId: 'dev-wv', playerVersion: '0.1.0' })
  const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-wv'))
  expect(row.surface).toBe('webview')
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- tests/api/devices-register.test.ts`
Expected: FAIL — `surface` is not accepted/persisted yet (and TS error on the `surface` arg).

- [ ] **Step 5: Implement**

In `server/api/devices/register.post.ts`, extend the schema and upsert:

```ts
const BodySchema = z.object({
  deviceId: z.string().min(1).max(128),
  playerVersion: z.string().min(1).max(64),
  surface: z.enum(['webview', 'native']).optional()
})
```

In the `.values({...})` object add `...(body.surface ? { surface: body.surface } : {})`, and in the `.onConflictDoUpdate({ set: {...} })` object add the same `...(body.surface ? { surface: body.surface } : {})`. (Omitting `surface` leaves the column default on insert and unchanged on update.)

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- tests/api/devices-register.test.ts`
Expected: PASS (all existing register tests still green).

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.ts server/db/migrations server/api/devices/register.post.ts tests/api/devices-register.test.ts
git commit -m "feat(devices): add surface column + accept surface on register"
```

---

### Task 2: `telemetry` accepts `surface`

**Files:**
- Modify: `server/api/devices/[id]/telemetry.post.ts:7-13` (BodySchema), `:52-59` (devices update)
- Test: `tests/api/devices-telemetry.test.ts`

**Interfaces:**
- Produces: `TelemetryBody` gains optional `surface?: 'webview' | 'native'`.

- [ ] **Step 1: Write the failing test**

In `tests/api/devices-telemetry.test.ts`, add a test (follow the file's existing setup for seeding a device + playlist item; reuse whatever helper the file already uses to create a device row):

```ts
it('persists surface from telemetry', async () => {
  // seed a device row first (mirror the existing tests' device setup in this file)
  await handleRegister(db, { deviceId: 'dev-t', playerVersion: '0.1.0' })
  await handleTelemetry(db, 'dev-t', { currentItemId: null, surface: 'native' })
  const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-t'))
  expect(row.surface).toBe('native')
})
```

Add `import { handleRegister } from '~/server/api/devices/register.post'` if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/api/devices-telemetry.test.ts`
Expected: FAIL — `surface` not accepted/persisted.

- [ ] **Step 3: Implement**

In `telemetry.post.ts` `BodySchema` add `surface: z.enum(['webview', 'native']).optional()`. In the `db.update(schema.devices).set({...})` object, add alongside the `apkVersion` spread:

```ts
      ...(body.surface !== undefined ? { surface: body.surface } : {})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/api/devices-telemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/[id]/telemetry.post.ts tests/api/devices-telemetry.test.ts
git commit -m "feat(devices): accept surface on telemetry"
```

---

### Task 3: Expose `surface` in status + device list + dashboard badge

**Files:**
- Modify: `server/api/devices/[id]/status.get.ts:11-18` (type), `:55` (return)
- Modify: `server/api/devices/index.get.ts:38-49` (addressId-branch column list)
- Modify: `app/pages/devices/[id].vue` (badge in device detail)
- Test: `tests/api/devices-status.test.ts`, `tests/api/devices.test.ts`

**Interfaces:**
- Consumes: `devices.surface` (Task 1).
- Produces: `DeviceStatus.surface: 'webview' | 'native'`; device-list rows include `surface`.

- [ ] **Step 1: Write the failing tests**

In `tests/api/devices-status.test.ts` add (mirror the file's device-seeding pattern):

```ts
it('returns the device surface', async () => {
  await handleRegister(db, { deviceId: 'dev-s', playerVersion: '0.1.0', surface: 'native' })
  const status = await handleDeviceStatus(db, 'dev-s')
  expect(status.surface).toBe('native')
})
```

In `tests/api/devices.test.ts` add a test asserting a listed device row includes `surface` (use the existing list helper `handleListDevices`); for a freshly-registered device expect `row.surface` to be `'webview'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/api/devices-status.test.ts tests/api/devices.test.ts`
Expected: FAIL — `surface` missing from status type and (in the addressId branch) from list rows.

- [ ] **Step 3: Implement status**

In `status.get.ts`, add `surface: 'webview' | 'native'` to the `DeviceStatus` type, and in the returned object add `surface: (device.surface as 'webview' | 'native')`.

- [ ] **Step 4: Implement list**

In `devices/index.get.ts`, the default `.select()` branch already returns all columns. In the **explicit** `addressId` branch column list (`:38-49`), add `surface: schema.devices.surface,` so both code paths return it.

- [ ] **Step 5: Implement dashboard badge**

In `app/pages/devices/[id].vue`, where the device's `apkVersion`/`playerVersion` are shown, render a small badge for the surface. Use the existing Nuxt UI `UBadge` already used elsewhere in the dashboard:

```vue
<UBadge :color="status.surface === 'native' ? 'primary' : 'neutral'" variant="subtle" size="sm">
  {{ status.surface === 'native' ? 'Native' : 'WebView' }}
</UBadge>
```

(Place it next to the existing version display; bind to whatever reactive `status`/device object the page already holds. If the detail page reads from the device-list store rather than the status endpoint, read `device.surface` instead.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- tests/api/devices-status.test.ts tests/api/devices.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the dashboard renders**

Run: `pnpm build` then `node .output/server/index.mjs` (with `PORT=5100`); confirm a device detail page shows the badge. (Or `PORT=5100 pnpm dev` for a quick check.)

- [ ] **Step 8: Commit**

```bash
git add server/api/devices app/pages/devices/[id].vue tests/api/devices-status.test.ts tests/api/devices.test.ts
git commit -m "feat(devices): surface in status/list + dashboard badge"
```

---

## Phase 2 — Server: OTA artifact flavor tag (additive, TDD)

### Task 4: `apk_releases.flavor` column + upload accepts flavor + list returns it

**Files:**
- Modify: `server/db/schema.ts` (apkReleases table)
- Generate: `server/db/migrations/<nnnn>_*.sql`
- Modify: `server/api/apk/upload.post.ts` (input + insert + form field)
- Test: `tests/api/apk-upload.test.ts` (create if absent — follow `tests/api/devices-register.test.ts` structure)

**Interfaces:**
- Produces: `apkReleases.flavor` (`'webview' | 'native'`, default `'webview'`); `UploadApkInput.flavor`.

- [ ] **Step 1: Add the column**

In `server/db/schema.ts` `apkReleases`, add after `size`:

```ts
  flavor: text('flavor').notNull().default('webview'),
```

- [ ] **Step 2: Generate + apply migration**

Run: `pnpm db:generate` then `pnpm db:migrate`
Expected: `ALTER TABLE \`apk_releases\` ADD \`flavor\` text DEFAULT 'webview' NOT NULL;`

- [ ] **Step 3: Write the failing test**

Create `tests/api/apk-upload.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleUploadApk } from '~/server/api/apk/upload.post'
import { LocalDiskStore } from '~/server/services/local-disk-store'
import * as schema from '~/server/db/schema'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('handleUploadApk', () => {
  let db: TestDb; let close: () => void; let store: LocalDiskStore
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close; store = new LocalDiskStore(mkdtempSync(join(tmpdir(), 'apk-'))) })
  afterEach(() => close())

  it('persists flavor on upload', async () => {
    const row = await handleUploadApk(db, store, {
      sha256: 'a'.repeat(64), version: '1.0.0', size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])), uploadedBy: null, flavor: 'native'
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r.flavor).toBe('native')
  })

  it('defaults flavor to webview', async () => {
    const row = await handleUploadApk(db, store, {
      sha256: 'b'.repeat(64), version: '1.0.0', size: 3,
      stream: Readable.from(Buffer.from([1, 2, 3])), uploadedBy: null
    })
    const [r] = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(r.flavor).toBe('webview')
  })
})
```

(Confirm `LocalDiskStore`'s import path/constructor against `server/services/media-store.ts`; adjust if the local store is exported elsewhere. If a simpler in-repo MediaStore test double exists, prefer it.)

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- tests/api/apk-upload.test.ts`
Expected: FAIL — `flavor` not on `UploadApkInput`/insert.

- [ ] **Step 5: Implement**

In `server/api/apk/upload.post.ts`:
- Add `flavor?: 'webview' | 'native'` to `UploadApkInput`.
- In the insert `.values({...})`, add `...(input.flavor ? { flavor: input.flavor } : {})`.
- In the `defineEventHandler`, read an optional `flavor` form part: `const flavorPart = form.find(p => p.name === 'flavor')`; `const flavor = flavorPart?.data?.toString('utf8').trim() as 'webview' | 'native' | undefined`; pass `flavor` into `handleUploadApk`. (No validation beyond the enum; absent → default.)

- [ ] **Step 6: Run test + commit**

Run: `pnpm test -- tests/api/apk-upload.test.ts` → PASS.

```bash
git add server/db/schema.ts server/db/migrations server/api/apk/upload.post.ts tests/api/apk-upload.test.ts
git commit -m "feat(apk): tag releases with flavor (webview|native) for OTA matching"
```

> Note: `apk/index.get.ts` already returns all columns via `.select()`, so the list endpoint surfaces `flavor` automatically. Dashboard filtering (only offer `native` releases to `native` devices in the OTA picker) is a small follow-on in the APK/devices admin UI; wire it where the OTA command is dispatched, gating the release dropdown on the selected device's `surface`.

---

## Phase 3 — Android: flavor scaffold + kiosk base extraction

### Task 5: Add the `surface` flavor dimension + native deps + stub PlayerActivity

**Files:**
- Modify: `android/app/build.gradle.kts`
- Modify: `android/build.gradle.kts` (add kotlin serialization plugin classpath)
- Create: `android/app/src/native/kotlin/ai/lanka/kiosk/PlayerActivity.kt` (stub)
- Create: `android/app/src/native/res/layout/activity_player.xml` (stub)
- Create: `android/app/src/native/AndroidManifest.xml`
- Create: `android/app/src/webview/AndroidManifest.xml`
- Modify: `android/app/src/main/AndroidManifest.xml` (remove the activity, keep shared)

**Interfaces:**
- Produces: two flavors `webview`/`native`; `assembleNativeDebug` builds a launchable stub.

- [ ] **Step 1: Add the serialization plugin to the root build**

In `android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.22" apply false
}
```

- [ ] **Step 2: Configure flavors + deps in the app build**

In `android/app/build.gradle.kts`, add `id("org.jetbrains.kotlin.plugin.serialization")` to the `plugins {}` block. Inside `android {}` (after `buildTypes`) add:

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

In `dependencies {}` add (native-scoped so the WebView APK is untouched):

```kotlin
    val media3 = "1.3.1"
    "nativeImplementation"("androidx.media3:media3-exoplayer:$media3")
    "nativeImplementation"("androidx.media3:media3-ui:$media3")
    "nativeImplementation"("com.squareup.okhttp3:okhttp:4.12.0")
    "nativeImplementation"("com.squareup.okhttp3:okhttp-sse:4.12.0")
    "nativeImplementation"("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
```

- [ ] **Step 3: Create the stub native layout**

`android/app/src/native/res/layout/activity_player.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/player_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#000000" />
```

- [ ] **Step 4: Create the stub PlayerActivity**

`android/app/src/native/kotlin/ai/lanka/kiosk/PlayerActivity.kt`:

```kotlin
package ai.lanka.kiosk

import android.app.Activity
import android.os.Bundle

/** Native (ExoPlayer) player entry point. Filled in by later tasks. */
class PlayerActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        KioskFlags.apply(this)
        DevicePolicy.applyKioskPolicies(this)
        setContentView(R.layout.activity_player)
    }
}
```

- [ ] **Step 5: Split the manifests**

Edit `android/app/src/main/AndroidManifest.xml`: **remove** the entire `<activity android:name=".MainActivity"> … </activity>` block. Keep everything else (permissions, `uses-feature`, the three `<receiver>`s, the `<application>` attributes).

Create `android/app/src/webview/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
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
    </application>
</manifest>
```

Create `android/app/src/native/AndroidManifest.xml` — identical but `android:name=".PlayerActivity"`.

- [ ] **Step 6: Build both flavors**

Run:
```bash
cd android && ./gradlew assembleWebviewDebug assembleNativeDebug
```
Expected: BUILD SUCCESSFUL; two APKs under `app/build/outputs/apk/{webview,native}/debug/`. (`MainActivity`/`LankaWebViewClient`/etc. are still in `src/main` at this point — they compile into both flavors, which is fine; Task 6 relocates them.)

- [ ] **Step 7: Commit**

```bash
git add android/build.gradle.kts android/app/build.gradle.kts android/app/src
git commit -m "build(android): add surface flavor dimension (webview|native) + native deps + stub PlayerActivity"
```

---

### Task 6: Relocate WebView-only classes into `src/webview`

**Files:**
- Move: `MainActivity.kt`, `LankaWebViewClient.kt`, `LankaChromeClient.kt`, `NativeFSBridge.kt` → `src/webview/kotlin/ai/lanka/kiosk/`
- Move: `res/layout/activity_main.xml` → `src/webview/res/layout/`

**Interfaces:**
- Produces: WebView classes compile only into the `webview` flavor; `native` flavor no longer contains them.

- [ ] **Step 1: git-move the WebView Kotlin + layout**

```bash
cd android/app/src
mkdir -p webview/kotlin/ai/lanka/kiosk webview/res/layout
git mv main/kotlin/ai/lanka/kiosk/MainActivity.kt webview/kotlin/ai/lanka/kiosk/
git mv main/kotlin/ai/lanka/kiosk/LankaWebViewClient.kt webview/kotlin/ai/lanka/kiosk/
git mv main/kotlin/ai/lanka/kiosk/LankaChromeClient.kt webview/kotlin/ai/lanka/kiosk/
git mv main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt webview/kotlin/ai/lanka/kiosk/
git mv main/res/layout/activity_main.xml webview/res/layout/
```

- [ ] **Step 2: Build both flavors**

Run: `cd android && ./gradlew assembleWebviewDebug assembleNativeDebug`
Expected: BUILD SUCCESSFUL. The `native` flavor compiles without the WebView classes (confirms no `src/main` code references them — `OtaResultBus`/`MediaCache` are referenced by `MainActivity` but live in `src/main`; `MainActivity` lives in `webview` now, so the dependency direction is fine).

If the `native` build fails because some `src/main` file references a moved class, that reference belongs in `src/webview` — move that file too and note it.

- [ ] **Step 3: Run Android unit tests**

Run: `cd android && ./gradlew testWebviewDebugUnitTest testNativeDebugUnitTest`
Expected: existing `MediaCacheTest`/`OtaInstallerTest` pass under both flavors (they live in `src/test`, shared).

- [ ] **Step 4: Commit**

```bash
git add android/app/src
git commit -m "refactor(android): move WebView-only classes to src/webview source set"
```

---

### Task 7: Extract a `KioskActivity` base for shared kiosk lifecycle

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/KioskActivity.kt`
- Modify: `android/app/src/webview/kotlin/ai/lanka/kiosk/MainActivity.kt`

**Interfaces:**
- Produces: `open class KioskActivity : Activity` with the surface-agnostic kiosk lifecycle (snap-back, lock-task, BACK swallow, focus re-apply). `MainActivity` and (later) `PlayerActivity` extend it.

- [ ] **Step 1: Create the base class**

`KioskActivity.kt` — lift the surface-agnostic kiosk lifecycle out of `MainActivity` verbatim (the snap-back runnable, `onResume` start-kiosk + cancel-return, `onUserLeaveHint`, `onStop`, `scheduleKioskReturn`, `onWindowFocusChanged`, `onKeyDown` BACK swallow, and the `KIOSK_RETURN_MS` constant):

```kotlin
package ai.lanka.kiosk

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent

/** Surface-agnostic kiosk lifecycle shared by the WebView and native players. */
open class KioskActivity : Activity() {

    protected val mainHandler = Handler(Looper.getMainLooper())

    private val kioskReturnRunnable = Runnable {
        startActivity(
            Intent(this, this::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
    }

    override fun onResume() {
        super.onResume()
        DevicePolicy.startKioskMode(this)
        mainHandler.removeCallbacks(kioskReturnRunnable)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        scheduleKioskReturn()
    }

    override fun onStop() {
        super.onStop()
        if (!isFinishing && !isChangingConfigurations) scheduleKioskReturn()
    }

    protected fun scheduleKioskReturn() {
        if (!KioskLock.locked) return
        mainHandler.removeCallbacks(kioskReturnRunnable)
        mainHandler.postDelayed(kioskReturnRunnable, KIOSK_RETURN_MS)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) KioskFlags.apply(this)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && KioskLock.locked) return true
        return super.onKeyDown(keyCode, event)
    }

    companion object {
        private const val KIOSK_RETURN_MS = 400L
    }
}
```

> Note: the base's snap-back relaunches `this::class.java`, so each subclass re-foregrounds itself — correct for both activities.

- [ ] **Step 2: Trim MainActivity to extend the base**

In `MainActivity.kt`: change `class MainActivity : Activity()` → `class MainActivity : KioskActivity()`. Delete the now-duplicated members (`kioskReturnRunnable`, `onResume`, `onUserLeaveHint`, `onStop`, `scheduleKioskReturn`, `onWindowFocusChanged`, `onKeyDown`, the `KIOSK_RETURN_MS` constant, and the private `mainHandler` field — use the inherited `protected mainHandler`). Keep the WebView-specific members (`scheduleReload`, `recoverFromRenderGone`, `configureWebView`, `onCreate`, `onDestroy`, reload constants). `onCreate` and `onDestroy` keep their WebView bodies (they already call `super`).

- [ ] **Step 3: Build + unit tests**

Run: `cd android && ./gradlew assembleWebviewDebug testWebviewDebugUnitTest`
Expected: BUILD SUCCESSFUL, tests pass. Behavior is unchanged (same lifecycle code, now inherited).

- [ ] **Step 4: Commit**

```bash
git add android/app/src
git commit -m "refactor(android): extract KioskActivity base for shared kiosk lifecycle"
```

---

## Phase 4 — Native: pure Kotlin domain ports (test-first)

> All Phase 4 code lives under `android/app/src/native/kotlin/ai/lanka/kiosk/player/`; tests under `android/app/src/test/kotlin/ai/lanka/kiosk/player/`. Run native unit tests with `./gradlew testNativeDebugUnitTest`.

### Task 8: `Backoff` port

**Files:**
- Create: `…/player/Backoff.kt`
- Test: `…/test/…/player/BackoffTest.kt`

**Interfaces:**
- Produces: `fun backoff(attempt: Int): Long` — `min(1000 * 2^attempt, 30_000)` ms.

- [ ] **Step 1: Write the failing test** (`BackoffTest.kt`), porting `tests/player/backoff.test.ts`:

```kotlin
package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun `grows exponentially from 1s`() {
        assertEquals(1000L, backoff(0)); assertEquals(2000L, backoff(1)); assertEquals(4000L, backoff(2))
    }
    @Test fun `caps at 30s`() {
        assertEquals(30_000L, backoff(10)); assertEquals(30_000L, backoff(100))
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `cd android && ./gradlew testNativeDebugUnitTest --tests '*BackoffTest'` → FAIL (unresolved `backoff`).

- [ ] **Step 3: Implement** (`Backoff.kt`):

```kotlin
package ai.lanka.kiosk.player

import kotlin.math.min

/** Exponential backoff capped at 30s. Reset attempt to 0 on success. */
fun backoff(attempt: Int): Long = min(1000L * (1L shl attempt), 30_000L)
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit** — `git add android/app/src && git commit -m "feat(native): port backoff()"`

---

### Task 9: `ManifestKey` + `shouldReconcile` port

**Files:**
- Create: `…/player/ManifestKey.kt`
- Test: `…/test/…/player/ShouldReconcileTest.kt`

**Interfaces:**
- Produces: `data class ManifestKey(val playlistId: Int, val version: Int)`; `fun shouldReconcile(prev: ManifestKey?, next: ManifestKey): Boolean`.

- [ ] **Step 1: Write the failing test**, porting `tests/player/shouldReconcile.test.ts`:

```kotlin
package ai.lanka.kiosk.player
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShouldReconcileTest {
    @Test fun `null prev always reconciles`() = assertTrue(shouldReconcile(null, ManifestKey(1, 1)))
    @Test fun `same key does not reconcile`() = assertFalse(shouldReconcile(ManifestKey(1, 2), ManifestKey(1, 2)))
    @Test fun `version change reconciles`() = assertTrue(shouldReconcile(ManifestKey(1, 1), ManifestKey(1, 2)))
    @Test fun `playlist change reconciles`() = assertTrue(shouldReconcile(ManifestKey(1, 1), ManifestKey(2, 1)))
}
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (`ManifestKey.kt`):

```kotlin
package ai.lanka.kiosk.player

data class ManifestKey(val playlistId: Int, val version: Int)

fun shouldReconcile(prev: ManifestKey?, next: ManifestKey): Boolean =
    prev == null || prev.playlistId != next.playlistId || prev.version != next.version
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(native): port ManifestKey + shouldReconcile"`

---

### Task 10: `Scheduler` port (the playlist state machine)

**Files:**
- Create: `…/player/Manifest.kt` (data classes), `…/player/Scheduler.kt`
- Test: `…/test/…/player/SchedulerTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `data class ManifestItem(val id: Int, val type: String, val sha256: String, val durationMs: Int)`
  - `data class Manifest(val playlistId: Int, val playlistName: String, val version: Int, val items: List<ManifestItem>)`
  - `enum class SchedulerMode { LOOP, SINGLE_VIDEO, SINGLE_IMAGE, EMPTY }`
  - `data class TransitionEvent(val from: Int, val to: Int, val nextPreload: Int)`
  - `interface SchedulerDeps { fun setTimeout(cb: () -> Unit, ms: Long): Any; fun clearTimeout(handle: Any) }`
  - `class Scheduler(items, deps)` with `mode`, `start()`, `itemEnded(index)`, `itemErrored(index, message)`, `stop()`, `getFrontIndex()`, `getBackIndex()`, and `onTransition`/`onItemStart`/`onItemError` registration returning an unsubscribe `() -> Unit`.

- [ ] **Step 1: Create the data classes** (`Manifest.kt`):

```kotlin
package ai.lanka.kiosk.player

import kotlinx.serialization.Serializable

@Serializable
data class ManifestItem(val id: Int, val type: String, val sha256: String, val durationMs: Int)

@Serializable
data class Manifest(
    val playlistId: Int,
    val playlistName: String,
    val version: Int,
    val items: List<ManifestItem>
)
```

- [ ] **Step 2: Write the failing tests** (`SchedulerTest.kt`) — port every case from `tests/player/createPlayerScheduler.test.ts`. Use a fake deps with a manual clock:

```kotlin
package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Test

private class FakeDeps : SchedulerDeps {
    private data class P(val cb: () -> Unit, val at: Long, val id: Int)
    private var now = 0L; private var nextId = 1; private val pending = mutableListOf<P>()
    override fun setTimeout(cb: () -> Unit, ms: Long): Any { val id = nextId++; pending.add(P(cb, now + ms, id)); return id }
    override fun clearTimeout(handle: Any) { pending.removeAll { it.id == handle } }
    fun pending() = pending.size
    fun advanceTime(ms: Long) {
        now += ms
        while (true) {
            val due = pending.firstOrNull { it.at <= now } ?: break
            pending.remove(due); due.cb()
        }
    }
}
private fun video(id: Int, dur: Int = 10_000) = ManifestItem(id, "video", "sha-$id", dur)
private fun image(id: Int, dur: Int = 8_000) = ManifestItem(id, "image", "sha-$id", dur)

class SchedulerTest {
    @Test fun `emits onItemStart(0) on start with multi-item`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), image(3)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(listOf(0), starts); assertEquals(0, s.getFrontIndex()); assertEquals(1, s.getBackIndex())
        assertEquals(SchedulerMode.LOOP, s.mode)
    }

    @Test fun `advances front on itemEnded with transition + start`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val t = mutableListOf<TransitionEvent>(); val starts = mutableListOf<Int>()
        s.onTransition { t.add(it) }; s.onItemStart { starts.add(it) }; s.start()
        s.itemEnded(0)
        assertEquals(listOf(TransitionEvent(0, 1, 2)), t); assertEquals(listOf(0, 1), starts)
        assertEquals(1, s.getFrontIndex()); assertEquals(2, s.getBackIndex())
        s.itemEnded(1); assertEquals(TransitionEvent(1, 2, 0), t[1])
        s.itemEnded(2); assertEquals(TransitionEvent(2, 0, 1), t[2]); assertEquals(0, s.getFrontIndex())
    }

    @Test fun `ignores stale itemEnded`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val t = mutableListOf<TransitionEvent>(); s.onTransition { t.add(it) }; s.start()
        s.itemEnded(0); assertEquals(1, t.size); s.itemEnded(0); assertEquals(1, t.size)
    }

    @Test fun `arms image timer for durationMs`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 5_000), video(2)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(1, deps.pending()); deps.advanceTime(4_999); assertEquals(listOf(0), starts)
        deps.advanceTime(1); assertEquals(listOf(0, 1), starts); assertEquals(1, s.getFrontIndex())
    }

    @Test fun `no timer for video items`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), image(2)), deps); s.start(); assertEquals(0, deps.pending())
    }

    @Test fun `clears image timer on itemEnded`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 5_000), video(2)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start(); assertEquals(1, deps.pending())
        s.itemEnded(0); assertEquals(0, deps.pending()); deps.advanceTime(10_000); assertEquals(listOf(0, 1), starts)
    }

    @Test fun `itemErrored emits error and advances`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2), video(3)), deps)
        val errs = mutableListOf<Pair<Int, String>>(); val t = mutableListOf<TransitionEvent>()
        s.onItemError { i, m -> errs.add(i to m) }; s.onTransition { t.add(it) }; s.start()
        s.itemErrored(0, "decode failed"); assertEquals(listOf(0 to "decode failed"), errs)
        assertEquals(1, t.size); assertEquals(1, s.getFrontIndex())
    }

    @Test fun `single video mode does not advance`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1)), deps)
        val t = mutableListOf<TransitionEvent>(); val starts = mutableListOf<Int>()
        s.onTransition { t.add(it) }; s.onItemStart { starts.add(it) }; s.start()
        assertEquals(SchedulerMode.SINGLE_VIDEO, s.mode); assertEquals(listOf(0), starts)
        s.itemEnded(0); assertEquals(0, t.size); assertEquals(0, s.getFrontIndex())
    }

    @Test fun `single image re-arms timer and re-emits start(0)`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 3_000)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(SchedulerMode.SINGLE_IMAGE, s.mode); assertEquals(listOf(0), starts); assertEquals(1, deps.pending())
        deps.advanceTime(3_000); assertEquals(listOf(0, 0), starts); assertEquals(1, deps.pending())
        deps.advanceTime(3_000); assertEquals(listOf(0, 0, 0), starts)
    }

    @Test fun `stop cancels timer and halts emission`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(image(1, 5_000)), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start(); assertEquals(1, deps.pending())
        s.stop(); assertEquals(0, deps.pending()); deps.advanceTime(10_000); assertEquals(listOf(0), starts)
    }

    @Test fun `empty items is inert`() {
        val deps = FakeDeps(); val s = Scheduler(emptyList(), deps)
        val starts = mutableListOf<Int>(); s.onItemStart { starts.add(it) }; s.start()
        assertEquals(emptyList<Int>(), starts); assertEquals(0, deps.pending()); assertEquals(SchedulerMode.EMPTY, s.mode)
    }

    @Test fun `onItemStart returns unsubscribe`() {
        val deps = FakeDeps(); val s = Scheduler(listOf(video(1), video(2)), deps)
        val starts = mutableListOf<Int>(); val unsub = s.onItemStart { starts.add(it) }; s.start(); unsub(); s.itemEnded(0)
        assertEquals(listOf(0), starts)
    }
}
```

- [ ] **Step 3: Run → FAIL** (`Scheduler` unresolved). `cd android && ./gradlew testNativeDebugUnitTest --tests '*SchedulerTest'`

- [ ] **Step 4: Implement** (`Scheduler.kt`) — a direct port of `createPlayerScheduler.ts`:

```kotlin
package ai.lanka.kiosk.player

enum class SchedulerMode { LOOP, SINGLE_VIDEO, SINGLE_IMAGE, EMPTY }

data class TransitionEvent(val from: Int, val to: Int, val nextPreload: Int)

interface SchedulerDeps {
    fun setTimeout(cb: () -> Unit, ms: Long): Any
    fun clearTimeout(handle: Any)
}

class Scheduler(private val items: List<ManifestItem>, private val deps: SchedulerDeps) {

    val mode: SchedulerMode = when {
        items.isEmpty() -> SchedulerMode.EMPTY
        items.size == 1 -> if (items[0].type == "video") SchedulerMode.SINGLE_VIDEO else SchedulerMode.SINGLE_IMAGE
        else -> SchedulerMode.LOOP
    }

    private var front = 0
    private var back = if (items.size > 1) 1 % items.size else 0
    private var stopped = false
    private var imageTimer: Any? = null

    private val itemStartHandlers = mutableSetOf<(Int) -> Unit>()
    private val transitionHandlers = mutableSetOf<(TransitionEvent) -> Unit>()
    private val errorHandlers = mutableSetOf<(Int, String) -> Unit>()

    private fun emitItemStart(i: Int) = itemStartHandlers.toList().forEach { it(i) }
    private fun emitTransition(e: TransitionEvent) = transitionHandlers.toList().forEach { it(e) }
    private fun emitError(i: Int, msg: String) = errorHandlers.toList().forEach { it(i, msg) }

    private fun clearImageTimer() { imageTimer?.let { deps.clearTimeout(it) }; imageTimer = null }

    private fun armImageTimerIfNeeded(index: Int) {
        val item = items.getOrNull(index) ?: return
        if (item.type != "image") return
        val durationMs = maxOf(0, item.durationMs).toLong()
        imageTimer = deps.setTimeout({
            imageTimer = null
            if (stopped) return@setTimeout
            if (mode == SchedulerMode.SINGLE_IMAGE) { emitItemStart(0); armImageTimerIfNeeded(0); return@setTimeout }
            advance()
        }, durationMs)
    }

    private fun advance() {
        if (stopped || mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO) return
        if (mode == SchedulerMode.SINGLE_IMAGE) return
        clearImageTimer()
        val from = front; val to = back
        front = to; back = (to + 1) % items.size
        emitTransition(TransitionEvent(from, to, back))
        emitItemStart(front)
        armImageTimerIfNeeded(front)
    }

    fun start() {
        if (stopped || mode == SchedulerMode.EMPTY) return
        emitItemStart(0); armImageTimerIfNeeded(0)
    }

    fun itemEnded(index: Int) {
        if (stopped || mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    fun itemErrored(index: Int, message: String) {
        if (stopped) return
        emitError(index, message)
        if (mode == SchedulerMode.EMPTY || mode == SchedulerMode.SINGLE_VIDEO || mode == SchedulerMode.SINGLE_IMAGE) return
        if (index != front) return
        advance()
    }

    fun stop() {
        stopped = true; clearImageTimer()
        itemStartHandlers.clear(); transitionHandlers.clear(); errorHandlers.clear()
    }

    fun getFrontIndex() = front
    fun getBackIndex() = back

    fun onTransition(fn: (TransitionEvent) -> Unit): () -> Unit { transitionHandlers.add(fn); return { transitionHandlers.remove(fn) } }
    fun onItemStart(fn: (Int) -> Unit): () -> Unit { itemStartHandlers.add(fn); return { itemStartHandlers.remove(fn) } }
    fun onItemError(fn: (Int, String) -> Unit): () -> Unit { errorHandlers.add(fn); return { errorHandlers.remove(fn) } }
}
```

- [ ] **Step 5: Run → PASS** (all ported cases green).

- [ ] **Step 6: Commit** — `git add android/app/src && git commit -m "feat(native): port playlist Scheduler state machine"`

---

### Task 11: `MediaCache.file(sha)` accessor

**Files:**
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MediaCache.kt`
- Test: `android/app/src/test/kotlin/ai/lanka/kiosk/MediaCacheTest.kt`

**Interfaces:**
- Produces: `fun file(sha256: String): File` — the cached file handle (may not exist) for ExoPlayer to read directly.

- [ ] **Step 1: Write the failing test** in `MediaCacheTest.kt`:

```kotlin
@Test fun `file returns handle inside cache dir ending in sha`() {
    val sha = "a".repeat(64)
    val f = cache.file(sha)
    assertEquals(sha, f.name)
    assertTrue(f.parentFile!!.absolutePath == tempDir.absolutePath)
}
```

- [ ] **Step 2: Run → FAIL** — `cd android && ./gradlew testWebviewDebugUnitTest --tests '*MediaCacheTest'` (unresolved `file`).

- [ ] **Step 3: Implement** — add to `MediaCache` (near `fileUrl`):

```kotlin
    /** The cached file handle for [sha256] (may not exist). For native (ExoPlayer)
     *  playback, which reads local files directly — no http interception needed. */
    fun file(sha256: String): File = File(dir, sha256)
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(android): MediaCache.file() accessor for native direct-file playback"`

---

## Phase 5 — Native: networking clients (test the pure cores)

### Task 12: `ManifestDiffer` (pure) + `ManifestClient` (OkHttp transport)

**Files:**
- Create: `…/player/ManifestDiffer.kt`, `…/player/ManifestClient.kt`
- Test: `…/test/…/player/ManifestDifferTest.kt`

**Interfaces:**
- Produces:
  - `sealed interface ManifestDecision { object Ignore; object EmitNull; data class Emit(val manifest: Manifest) }` (use `data object` for the singletons)
  - `class ManifestDiffer { fun onFetched(result: Manifest?): ManifestDecision }` — mirrors `useReconciler` emit logic: first fetch or transition-to-null emits `EmitNull`; a changed `playlistId+version` emits `Emit`; an unchanged key returns `Ignore`; repeated nulls return `Ignore`.
  - `class ManifestClient(deviceId, serverBaseUrl, http: OkHttpClient, json: Json, mediaCache, onManifest: (Manifest?) -> Unit, onError: (Throwable) -> Unit)` with `register(surface, playerVersion)`, `reconcile()`, `openStream()`, `startPolling()`, `close()`. (Transport — verified on-box, not unit tested.)

- [ ] **Step 1: Write the failing test** (`ManifestDifferTest.kt`), porting the emit-dedup cases from `tests/player/useReconciler.test.ts`:

```kotlin
package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ManifestDifferTest {
    private fun m(pl: Int, v: Int) = Manifest(pl, "p", v, listOf(ManifestItem(1, "video", "sha-1", 1000)))

    @Test fun `first non-null emits`() {
        val d = ManifestDiffer()
        assertTrue(d.onFetched(m(1, 1)) is ManifestDecision.Emit)
    }
    @Test fun `unchanged key is ignored`() {
        val d = ManifestDiffer(); d.onFetched(m(1, 1))
        assertEquals(ManifestDecision.Ignore, d.onFetched(m(1, 1)))
    }
    @Test fun `version bump re-emits`() {
        val d = ManifestDiffer(); d.onFetched(m(1, 1))
        assertTrue(d.onFetched(m(1, 2)) is ManifestDecision.Emit)
    }
    @Test fun `first null emits null once then ignores`() {
        val d = ManifestDiffer()
        assertEquals(ManifestDecision.EmitNull, d.onFetched(null))
        assertEquals(ManifestDecision.Ignore, d.onFetched(null))
    }
    @Test fun `manifest then null emits null`() {
        val d = ManifestDiffer(); d.onFetched(m(1, 1))
        assertEquals(ManifestDecision.EmitNull, d.onFetched(null))
    }
}
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `ManifestDiffer.kt`** (port of the reconcile decision in `useReconciler.ts:110-142`):

```kotlin
package ai.lanka.kiosk.player

sealed interface ManifestDecision {
    data object Ignore : ManifestDecision
    data object EmitNull : ManifestDecision
    data class Emit(val manifest: Manifest) : ManifestDecision
}

/** Pure manifest emit/dedup logic, mirroring useReconciler. */
class ManifestDiffer {
    private var last: ManifestKey? = null
    private var hasEmitted = false

    fun onFetched(result: Manifest?): ManifestDecision {
        if (result == null) {
            return if (last != null || !hasEmitted) {
                last = null; hasEmitted = true; ManifestDecision.EmitNull
            } else ManifestDecision.Ignore
        }
        val key = ManifestKey(result.playlistId, result.version)
        if (!shouldReconcile(last, key)) return ManifestDecision.Ignore
        last = key; hasEmitted = true
        return ManifestDecision.Emit(result)
    }
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Implement `ManifestClient.kt`** (transport; not unit-tested — verified on-box in Task 17). It owns OkHttp + an `okhttp-sse` `EventSource`, uses `ManifestDiffer`, pre-downloads media via `MediaCache.downloadSync` + `evictExcept`, posts `register`, polls every 30s, and reconnects SSE. Skeleton:

```kotlin
package ai.lanka.kiosk.player

import ai.lanka.kiosk.MediaCache
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ManifestClient(
    private val deviceId: String,
    private val serverBaseUrl: String,   // e.g. BuildConfig.LANKA_SERVER_URL
    private val mediaPublicBase: String, // "" for proxy /media path
    private val http: OkHttpClient,
    private val json: Json,
    private val mediaCache: MediaCache,
    private val onManifest: (Manifest?) -> Unit,
    private val onError: (Throwable) -> Unit
) {
    private val differ = ManifestDiffer()
    private val poll = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "manifest-poll").apply { isDaemon = true } }
    private var es: EventSource? = null
    @Volatile private var attempt = 0
    @Volatile private var closed = false

    private fun mediaUrl(sha: String) =
        if (mediaPublicBase.isNotEmpty()) "${mediaPublicBase.trimEnd('/')}/media/$sha" else "$serverBaseUrl/media/$sha"

    fun register(surface: String, playerVersion: String) {
        val body = json.encodeToString(
            RegisterBody.serializer(), RegisterBody(deviceId, playerVersion, surface)
        )
        runCatching {
            http.newCall(Request.Builder().url("$serverBaseUrl/api/devices/register")
                .post(RequestBody.create("application/json".toMediaTypeOrNull(), body)).build())
                .execute().close()
        }.onFailure { /* retried on next reconcile error */ }
    }

    fun reconcile() {
        if (closed) return
        try {
            val req = Request.Builder().url("$serverBaseUrl/api/devices/$deviceId/manifest").get().build()
            http.newCall(req).execute().use { resp ->
                attempt = 0
                val manifest: Manifest? = if (resp.code == 204) null else {
                    val raw = resp.body?.string().orEmpty()
                    if (raw.isBlank()) null else json.decodeFromString(Manifest.serializer(), raw)
                }
                when (val d = differ.onFetched(manifest)) {
                    is ManifestDecision.Ignore -> {}
                    is ManifestDecision.EmitNull -> onManifest(null)
                    is ManifestDecision.Emit -> {
                        prefetch(d.manifest)
                        onManifest(d.manifest)
                    }
                }
            }
        } catch (e: Throwable) {
            onError(e)
            poll.schedule({ reconcile() }, backoff(attempt), TimeUnit.MILLISECONDS)
            attempt += 1
        }
    }

    private fun prefetch(m: Manifest) {
        val shas = m.items.map { it.sha256 }
        shas.filterNot { mediaCache.exists(it) }.forEach { sha ->
            runCatching { mediaCache.downloadSync(sha, mediaUrl(sha)) }
        }
        mediaCache.evictExcept(shas.toSet())
    }

    fun openStream() {
        if (closed || es != null) return
        val req = Request.Builder().url("$serverBaseUrl/api/devices/$deviceId/stream").build()
        es = EventSources.createFactory(http).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) { reconcile() }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                when (type) { "manifest-changed" -> reconcile(); "reload" -> reconcile() /* PlayerActivity may recreate */ }
            }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                es = null
                if (!closed) poll.schedule({ openStream() }, backoff(attempt), TimeUnit.MILLISECONDS)
            }
        })
    }

    fun startPolling() { poll.scheduleWithFixedDelay({ reconcile() }, 30, 30, TimeUnit.SECONDS) }

    fun close() { closed = true; es?.cancel(); es = null; poll.shutdownNow() }
}
```

Add the serializable `RegisterBody`:

```kotlin
// in Manifest.kt
@kotlinx.serialization.Serializable
data class RegisterBody(val deviceId: String, val playerVersion: String, val surface: String)
```

Import `okhttp3.MediaType.Companion.toMediaTypeOrNull`. Configure the `OkHttpClient` in `PlayerActivity` with read timeout 0 (infinite) for SSE.

- [ ] **Step 6: Build native + run native unit tests**

Run: `cd android && ./gradlew assembleNativeDebug testNativeDebugUnitTest`
Expected: BUILD SUCCESSFUL; `ManifestDifferTest` passes.

- [ ] **Step 7: Commit** — `git add android/app/src && git commit -m "feat(native): ManifestDiffer + ManifestClient (poll/SSE/register/prefetch)"`

---

### Task 13: `TelemetryClient`

**Files:**
- Create: `…/player/TelemetryClient.kt`
- Test: `…/test/…/player/TelemetryClientTest.kt`

**Interfaces:**
- Consumes: a `Poster` seam for testability.
- Produces:
  - `interface TelemetryPoster { fun post(deviceId: String, jsonBody: String) }`
  - `class TelemetryClient(poster, apkVersion: String, surface: String = "native")` with `itemStarted(deviceId, itemId)`, `itemFailed(deviceId, itemId: Int?, sha256: String?, message)`, `clearedCurrent(deviceId)`.
- Body shape matches `telemetry.post.ts` `BodySchema`: `{ currentItemId, apkVersion, surface, error?: { sha256?, message } }`.

- [ ] **Step 1: Write the failing test** (`TelemetryClientTest.kt`) — port `useTelemetry` semantics; assert the JSON body each call posts:

```kotlin
package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class CapturingPoster : TelemetryPoster {
    val bodies = mutableListOf<Pair<String, String>>()
    override fun post(deviceId: String, jsonBody: String) { bodies.add(deviceId to jsonBody) }
}

class TelemetryClientTest {
    @Test fun `itemStarted posts currentItemId + surface + apkVersion`() {
        val p = CapturingPoster(); TelemetryClient(p, "1.0.0").itemStarted("dev", 42)
        val (dev, body) = p.bodies.single()
        assertEquals("dev", dev)
        assertTrue(body.contains("\"currentItemId\":42"))
        assertTrue(body.contains("\"surface\":\"native\""))
        assertTrue(body.contains("\"apkVersion\":\"1.0.0\""))
        assertTrue(!body.contains("error"))
    }
    @Test fun `itemFailed includes error object`() {
        val p = CapturingPoster(); TelemetryClient(p, "1.0.0").itemFailed("dev", 7, "sha-7", "decode")
        val body = p.bodies.single().second
        assertTrue(body.contains("\"currentItemId\":7"))
        assertTrue(body.contains("\"message\":\"decode\""))
        assertTrue(body.contains("\"sha256\":\"sha-7\""))
    }
    @Test fun `clearedCurrent posts null currentItemId`() {
        val p = CapturingPoster(); TelemetryClient(p, "1.0.0").clearedCurrent("dev")
        assertTrue(p.bodies.single().second.contains("\"currentItemId\":null"))
    }
}
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (`TelemetryClient.kt`) using kotlinx.serialization JSON objects:

```kotlin
package ai.lanka.kiosk.player

import kotlinx.serialization.json.*

interface TelemetryPoster { fun post(deviceId: String, jsonBody: String) }

class TelemetryClient(
    private val poster: TelemetryPoster,
    private val apkVersion: String,
    private val surface: String = "native"
) {
    private fun body(currentItemId: Int?, error: Pair<String?, String>? = null): String = buildJsonObject {
        put("currentItemId", currentItemId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("apkVersion", apkVersion)
        put("surface", surface)
        if (error != null) putJsonObject("error") {
            error.first?.let { put("sha256", it) }
            put("message", error.second)
        }
    }.toString()

    fun itemStarted(deviceId: String, currentItemId: Int) = poster.post(deviceId, body(currentItemId))
    fun itemFailed(deviceId: String, currentItemId: Int?, sha256: String?, message: String) =
        poster.post(deviceId, body(currentItemId, sha256 to message))
    fun clearedCurrent(deviceId: String) = poster.post(deviceId, body(null))
}
```

Also add a real OkHttp-backed `TelemetryPoster` (used in `PlayerActivity`, not unit-tested):

```kotlin
class OkHttpTelemetryPoster(private val http: okhttp3.OkHttpClient, private val serverBaseUrl: String) : TelemetryPoster {
    override fun post(deviceId: String, jsonBody: String) {
        val req = okhttp3.Request.Builder()
            .url("$serverBaseUrl/api/devices/$deviceId/telemetry")
            .post(okhttp3.RequestBody.create("application/json".let(okhttp3.MediaType::parse), jsonBody)).build()
        http.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {}
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) { response.close() }
        })
    }
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git add android/app/src && git commit -m "feat(native): TelemetryClient (item start/fail/clear with surface)"`

---

### Task 14: `CommandDispatcher` (pure) + `CommandClient` (OkHttp WS)

**Files:**
- Create: `…/player/CommandDispatcher.kt`, `…/player/CommandClient.kt`
- Test: `…/test/…/player/CommandDispatcherTest.kt`

**Interfaces:**
- Produces:
  - `interface CommandActions { fun reboot(): Boolean; fun screenshot(): String; fun getLogs(): String; fun setKioskLock(enabled: Boolean); fun installOta(sha256: String, url: String, commandId: Int): Boolean; fun reload() }`
  - `interface AckSender { fun send(json: String) }`
  - `class CommandDispatcher(actions, sender)` with `fun handle(commandJson: String)` — parses `{ commandId, cmd, payload }` and replies with `{ commandId, status, result? }`, mirroring `useCommandChannel.ts`.
  - `class CommandClient(deviceId, serverBaseUrl, http, dispatcher)` with `open()`/`close()` (OkHttp `WebSocket`, reconnect with `backoff`).

- [ ] **Step 1: Write the failing test** (`CommandDispatcherTest.kt`), porting `tests/player/useCommandChannel.test.ts` dispatch cases:

```kotlin
package ai.lanka.kiosk.player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeActions : CommandActions {
    var rebooted = false; var locked: Boolean? = null; var ota: Triple<String, String, Int>? = null; var reloaded = false
    override fun reboot(): Boolean { rebooted = true; return true }
    override fun screenshot() = "data:image/png;base64,AAAA"
    override fun getLogs() = "log-line-1"
    override fun setKioskLock(enabled: Boolean) { locked = enabled }
    override fun installOta(sha256: String, url: String, commandId: Int): Boolean { ota = Triple(sha256, url, commandId); return true }
    override fun reload() { reloaded = true }
}
private class FakeSender : AckSender { val sent = mutableListOf<String>(); override fun send(json: String) { sent.add(json) } }

class CommandDispatcherTest {
    @Test fun `screenshot acks with result`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":1,"cmd":"screenshot","payload":null}""")
        assertTrue(s.sent.single().contains("\"commandId\":1"))
        assertTrue(s.sent.single().contains("\"status\":\"acked\""))
        assertTrue(s.sent.single().contains("data:image/png"))
    }
    @Test fun `kiosk-lock toggles and acks`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":2,"cmd":"kiosk-lock","payload":null}""")
        assertEquals(true, a.locked); assertTrue(s.sent.single().contains("\"status\":\"acked\""))
    }
    @Test fun `log-request acks with logs`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":3,"cmd":"log-request","payload":null}""")
        assertTrue(s.sent.single().contains("log-line-1"))
    }
    @Test fun `reboot reboots and sends no ack`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":4,"cmd":"reboot","payload":null}""")
        assertTrue(a.rebooted); assertTrue(s.sent.isEmpty())
    }
    @Test fun `ota with missing payload fails`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":5,"cmd":"ota","payload":{}}""")
        assertTrue(s.sent.single().contains("\"status\":\"failed\""))
    }
    @Test fun `ota installs with sha + url`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s)
            .handle("""{"commandId":6,"cmd":"ota","payload":{"sha256":"abc","url":"http://h/x.apk"}}""")
        assertEquals(Triple("abc", "http://h/x.apk", 6), a.ota)
    }
    @Test fun `malformed json is ignored`() {
        val a = FakeActions(); val s = FakeSender(); CommandDispatcher(a, s).handle("not json")
        assertTrue(s.sent.isEmpty())
    }
}
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (`CommandDispatcher.kt`) — port the switch from `useCommandChannel.ts:44-125`. Reboot returns no ack (the hub marks it acked on delivery). OTA result is reported asynchronously by the installer; for the synchronous dispatcher, on a successful `installOta` kickoff send nothing here (the installer calls back the ack via `CommandClient`); on missing payload or kickoff failure, send a `failed` ack:

```kotlin
package ai.lanka.kiosk.player

import kotlinx.serialization.json.*

interface CommandActions {
    fun reboot(): Boolean
    fun screenshot(): String
    fun getLogs(): String
    fun setKioskLock(enabled: Boolean)
    fun installOta(sha256: String, url: String, commandId: Int): Boolean
    fun reload()
}
interface AckSender { fun send(json: String) }

class CommandDispatcher(private val actions: CommandActions, private val sender: AckSender) {
    private fun ack(commandId: Int, status: String, result: String? = null) = sender.send(
        buildJsonObject {
            put("commandId", commandId); put("status", status)
            if (result != null) put("result", result)
        }.toString()
    )

    fun handle(commandJson: String) {
        val obj = runCatching { Json.parseToJsonElement(commandJson).jsonObject }.getOrNull() ?: return
        val commandId = obj["commandId"]?.jsonPrimitive?.intOrNull ?: return
        val type = obj["cmd"]?.jsonPrimitive?.contentOrNull ?: return
        val payload = obj["payload"] as? JsonObject

        when (type) {
            "reboot" -> { runCatching { if (actions.reboot()) return }; actions.reload() }
            "screenshot" -> runCatching { ack(commandId, "acked", actions.screenshot()) }
                .onFailure { ack(commandId, "failed", it.toString()) }
            "kiosk-lock", "kiosk-unlock" -> runCatching {
                actions.setKioskLock(type == "kiosk-lock"); ack(commandId, "acked")
            }.onFailure { ack(commandId, "failed", it.toString()) }
            "log-request" -> runCatching { ack(commandId, "acked", actions.getLogs()) }
                .onFailure { ack(commandId, "failed", it.toString()) }
            "ota" -> {
                val sha = payload?.get("sha256")?.jsonPrimitive?.contentOrNull
                val url = payload?.get("url")?.jsonPrimitive?.contentOrNull
                if (sha.isNullOrBlank() || url.isNullOrBlank()) { ack(commandId, "failed", "missing sha256 or url"); return }
                if (!actions.installOta(sha, url, commandId)) ack(commandId, "failed", "install failed")
                // success ack is sent asynchronously by the OTA result callback
            }
            else -> ack(commandId, "failed", "unknown command")
        }
    }
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Implement `CommandClient.kt`** (OkHttp `WebSocket` transport; not unit-tested). It opens a WS to `/api/devices/:id/ws`, feeds `onMessage` text to `dispatcher.handle`, exposes an `AckSender` that writes to the socket, and reconnects on close with `backoff`. Wire `installOta` to the existing `OtaInstaller` + `MediaCache.downloadApk`-equivalent; reuse `OtaResultBus` so the async OTA result sends the final ack. (The webview path used `NativeFSBridge.downloadApk` → in native, call `OtaInstaller` directly with a `MediaCache`-downloaded APK file.)

- [ ] **Step 6: Build native + run native unit tests**

Run: `cd android && ./gradlew assembleNativeDebug testNativeDebugUnitTest`
Expected: BUILD SUCCESSFUL; `CommandDispatcherTest` passes.

- [ ] **Step 7: Commit** — `git add android/app/src && git commit -m "feat(native): CommandDispatcher + CommandClient (OTA/reboot/screenshot/logs/kiosk-lock)"`

---

## Phase 6 — Native: ExoPlayer UI + activity wiring + on-box verification

### Task 15: `PlaybackView` — ExoPlayer A/B stage with crossfade

**Files:**
- Create: `…/player/PlaybackView.kt`
- Modify: `android/app/src/native/res/layout/activity_player.xml`

**Interfaces:**
- Consumes: `Manifest`, `Scheduler`, `MediaCache`, a `fileUrlResolver` (sha → playable Uri string: local file if cached, else CDN/proxy URL), and callbacks `onItemStarted(itemId: Int)`, `onItemFailed(itemId: Int?, sha256: String?, message: String)`, `onCleared()`.
- Produces: `class PlaybackView(context)` (a `FrameLayout`) with `fun bind(manifest: Manifest, scheduler: Scheduler)` and `fun release()`. Mirrors `PlayerStage.vue`: two A/B slots (each a `PlayerView` with `texture_view` output + an `ImageView`), crossfade via alpha animators, consecutive-error → stalled → retry-after-15s self-heal, `single-video` → `REPEAT_MODE_ONE`.

- [ ] **Step 1: Replace the native layout** (`activity_player.xml`) with two stacked A/B slots — each a Media3 `PlayerView` (TextureView output for alpha blending) over an `ImageView`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:id="@+id/player_root"
    android:layout_width="match_parent" android:layout_height="match_parent"
    android:background="#000000">

    <FrameLayout android:id="@+id/slotA" android:layout_width="match_parent" android:layout_height="match_parent">
        <androidx.media3.ui.PlayerView android:id="@+id/videoA"
            android:layout_width="match_parent" android:layout_height="match_parent"
            app:surface_type="texture_view" app:use_controller="false" app:resize_mode="fit"/>
        <ImageView android:id="@+id/imageA" android:layout_width="match_parent" android:layout_height="match_parent"
            android:scaleType="fitCenter" android:visibility="gone"/>
    </FrameLayout>

    <FrameLayout android:id="@+id/slotB" android:layout_width="match_parent" android:layout_height="match_parent"
        android:alpha="0">
        <androidx.media3.ui.PlayerView android:id="@+id/videoB"
            android:layout_width="match_parent" android:layout_height="match_parent"
            app:surface_type="texture_view" app:use_controller="false" app:resize_mode="fit"/>
        <ImageView android:id="@+id/imageB" android:layout_width="match_parent" android:layout_height="match_parent"
            android:scaleType="fitCenter" android:visibility="gone"/>
    </FrameLayout>

    <TextView android:id="@+id/stalledBanner" android:layout_width="wrap_content" android:layout_height="wrap_content"
        android:layout_gravity="bottom|center_horizontal" android:layout_marginBottom="24dp"
        android:padding="8dp" android:textColor="#F4F4F5" android:background="#99000000"
        android:text="Playback stalled — waiting for next sync…" android:visibility="gone"/>
</FrameLayout>
```

- [ ] **Step 2: Implement `PlaybackView.kt`** — the native analogue of `PlayerStage.vue`. Two ExoPlayer instances (one per slot), preload the back slot, crossfade slot alphas (~120ms) on transition. Port the error/self-heal logic (constants `MAX_CONSECUTIVE_ERRORS = 5`, `RECOVERY_DELAY_MS = 15_000`). Key wiring:
  - `bind(manifest, scheduler)`: set item 0 in the front slot, item 1 in the back; `scheduler.onTransition { … flip front/back, set next preload, play front }`; `scheduler.onItemStart`/`onItemError` forward to the `onItemStarted`/`onItemFailed` callbacks; `scheduler.start()`.
  - Front video: `Player.repeatMode = if (scheduler.mode == SINGLE_VIDEO) REPEAT_MODE_ONE else REPEAT_MODE_OFF`; on `Player.STATE_ENDED` call `scheduler.itemEnded(frontIndex)`; on `onPlayerError` call `scheduler.itemErrored(frontIndex, msg)`.
  - Images: load with a lightweight decode off the UI thread (a `BitmapFactory` on the cached `MediaCache.file(sha)`); image timing is the scheduler's (`armImageTimerIfNeeded`), so the view only swaps the visible bitmap.
  - `fileUrlResolver(sha)`: return `Uri.fromFile(mediaCache.file(sha))` when `mediaCache.exists(sha)`, else the CDN/proxy URL.
  - `release()`: release both ExoPlayers, cancel animators + the recovery handler, unsubscribe scheduler handlers.

  > This is the one task tuned on-box (Task 17). If two simultaneous TextureView crossfades cost too much on the lowest-end target, fall back to hard cuts: skip the alpha animation and toggle slot visibility instantly — same `Scheduler` events, no other change.

- [ ] **Step 3: Build native**

Run: `cd android && ./gradlew assembleNativeDebug`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit** — `git add android/app/src && git commit -m "feat(native): ExoPlayer A/B PlaybackView with crossfade + self-heal"`

---

### Task 16: Wire `PlayerActivity` — boot the native player

**Files:**
- Modify: `android/app/src/native/kotlin/ai/lanka/kiosk/PlayerActivity.kt`

**Interfaces:**
- Consumes: `ManifestClient`, `Scheduler`, `PlaybackView`, `TelemetryClient`/`OkHttpTelemetryPoster`, `CommandClient`/`CommandDispatcher`, `MediaCache`, `KioskActivity`.
- Produces: a fully-wired native kiosk activity (the analogue of `usePlayerBoot` + `MainActivity`).

- [ ] **Step 1: Implement the wiring** — `PlayerActivity : KioskActivity()`:
  - `onCreate`: `KioskFlags.apply`, `DevicePolicy.applyKioskPolicies`, `setContentView(R.layout.activity_player)`. Resolve/persist `deviceId` (reuse the same SharedPreferences scheme as `MainActivity.deviceId()` — extract that helper into `src/main` `DeviceId.kt` if you want it shared, or duplicate the ~5 lines). Build a shared `OkHttpClient` (SSE-friendly: `readTimeout(0, MILLISECONDS)`), a `Json { ignoreUnknownKeys = true }`, and `MediaCache.get(this)`.
  - Construct `TelemetryClient(OkHttpTelemetryPoster(http, BuildConfig.LANKA_SERVER_URL), BuildConfig.VERSION_NAME)`.
  - Construct `ManifestClient(...)` with `onManifest = { m -> runOnUiThread { onManifest(m) } }` and `onError = { runOnUiThread { showStandbyIfNeverPlayed() } }`.
  - `onManifest(m)`: if `m == null` → show no-content view, `telemetry.clearedCurrent(deviceId)`, release `PlaybackView`. Else build a `Scheduler(m.items, AndroidSchedulerDeps(mainHandler))` (a `SchedulerDeps` backed by `Handler.postDelayed`/`removeCallbacks`), create/rebind `PlaybackView` with callbacks → `telemetry.itemStarted/itemFailed`, show the playing view.
  - Register + start: `manifestClient.register("native", PLAYER_VERSION)`, `reconcile()`, `openStream()`, `startPolling()`.
  - Construct `CommandClient(deviceId, serverBaseUrl, http, CommandDispatcher(actions, sender))` where `actions` calls `DevicePolicy.reboot(this)` / native screenshot / logcat dump / `KioskLock` / `OtaInstaller`; `open()` it.
  - SSE `reload` handling: in `ManifestClient.openStream`, route a `reload` event to `runOnUiThread { recreate() }`.
  - `onDestroy`: `manifestClient.close()`, `commandClient.close()`, `playbackView.release()`, then `super.onDestroy()`.
  - `AndroidSchedulerDeps`: `setTimeout { cb, ms -> val r = Runnable { cb() }; handler.postDelayed(r, ms); r }`, `clearTimeout { handler.removeCallbacks(it as Runnable) }`.

  Add a `companion object { const val PLAYER_VERSION = "native-1" }` (the value reported as `playerVersion`; `apkVersion` comes from `BuildConfig.VERSION_NAME`).

- [ ] **Step 2: Build native + all native unit tests**

Run: `cd android && ./gradlew assembleNativeDebug testNativeDebugUnitTest`
Expected: BUILD SUCCESSFUL; all native unit tests pass.

- [ ] **Step 3: Confirm the WebView flavor is still intact**

Run: `cd android && ./gradlew assembleWebviewDebug testWebviewDebugUnitTest`
Expected: BUILD SUCCESSFUL; existing tests pass.

- [ ] **Step 4: Commit** — `git add android/app/src && git commit -m "feat(native): wire PlayerActivity (manifest/scheduler/playback/telemetry/commands)"`

---

### Task 17: On-box verification against a production server

**Files:** none (verification only).

- [ ] **Step 1: Build a production server**

Run (in repo root): `pnpm build` then `PORT=5100 node .output/server/index.mjs`
(Or run against the dev box per `keep-local-dev-separate-from-prod`.)

- [ ] **Step 2: Build + install the native APK pointed at that server**

```bash
cd android && ./gradlew :app:assembleNativeDebug -PLANKA_SERVER_URL=http://<dev-box-ip>:5100
adb install -r app/build/outputs/apk/native/debug/app-native-debug.apk
adb shell am start -n ai.lanka.kiosk.vs/ai.lanka.kiosk.PlayerActivity
```

- [ ] **Step 3: Verify the playback path**
  - The device appears in the dashboard with a **Native** badge (Task 3).
  - Assign a playlist with a video + an image; confirm: video plays via ExoPlayer, image shows for its duration, crossfade looks right (or hard-cut fallback if you took it), loop wraps.
  - Edit the playlist → version bumps → SSE pushes the change → native player reconciles within a couple seconds.
  - Confirm play counts increment (media detail) and `currentItem` shows in device status.
  - Pull power / airplane-mode mid-loop, restore → it self-heals (no permanent black screen).

- [ ] **Step 4: Verify the command channel**
  - From the dashboard: screenshot (returns an image), log-request (returns logs), kiosk-lock/unlock (toggles snap-back), reboot (box reboots), and an OTA push of a `native`-flavor APK release (installs + comes back up). Confirm a `webview` release is NOT offered for this device (Task 4 dashboard gating).

- [ ] **Step 5: Side-by-side (optional)** — install both APKs (`ai.lanka.kiosk` + `ai.lanka.kiosk.vs`) on one box; confirm they register as two devices and both play.

- [ ] **Step 6: Final full test sweep**

Run: `pnpm test` (repo) and `cd android && ./gradlew test`
Expected: all green.

---

## Self-Review

**Spec coverage:**
- §Packaging/flavor → Tasks 5–6 (flavor dimension, source-set split). ✓
- §Kotlin brain: `ManifestClient` → Task 12; `Scheduler` → Task 10; `TelemetryClient` → Task 13; `CommandClient` → Task 14; `PlaybackView` → Task 15; `PlayerActivity` → Task 16. ✓
- §Media path simplification (`MediaCache.file`, direct ExoPlayer file playback) → Tasks 11 + 15. ✓
- §Dependencies (media3, okhttp, kotlinx.serialization, native-scoped) → Task 5. ✓
- §Server additive `surface` (migration, register, telemetry, status, list, dashboard badge) → Tasks 1–3. ✓
- §OTA artifact flavor matching (`apkReleases.flavor`) → Task 4 (+ dashboard gating noted in Task 4/17). ✓
- §Self-heal (no renderer process; ExoPlayer error→retry; manifest backoff; kiosk lifecycle) → Tasks 7, 12, 15, 16. ✓
- §Testing (gradle JVM ports of the vitest cases; webview regression; on-box prod build) → Phases 4–6. ✓
- §Non-goals (no transcode relaxation, no webview retirement, no runtime toggle) → respected; Global Constraints restate them. ✓

**Placeholder scan:** No "TBD"/"implement later". The two transport-heavy classes (`ManifestClient` transport, `CommandClient` WS, `PlaybackView` body) carry concrete skeletons; their pure cores (`ManifestDiffer`, `CommandDispatcher`, `Scheduler`) are fully test-driven. On-box tuning of the crossfade is explicitly flagged with a concrete fallback.

**Type consistency:** `Manifest`/`ManifestItem` shapes match the server `ManifestItem` (`id`, `type`, `sha256`, `durationMs`) and the vitest fixtures. `surface` values are the literal `'webview'|'native'` everywhere (schema, zod, Kotlin report). `Scheduler` method/event names match the TS interface (`onTransition`/`onItemStart`/`onItemError`, `itemEnded`/`itemErrored`, `getFrontIndex`/`getBackIndex`). `RegisterBody` fields match `register.post.ts` `BodySchema`.

---

## Execution Notes

- Phases 1–2 (server) are independent of Android and can be implemented/verified first.
- Phase 3 must precede Phases 4–6 (creates the source sets + deps the native code compiles into).
- Within Phase 4, Tasks 8–11 are independent of each other; Task 10 (Scheduler) is the highest-value port.
- Phase 5 depends on Phase 4 types (`Manifest`, `ManifestKey`, `backoff`); Phase 6 depends on all prior native tasks.
