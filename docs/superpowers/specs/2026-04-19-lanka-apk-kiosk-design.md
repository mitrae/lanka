# Lanka APK Kiosk — Design

**Status:** Design approved 2026-04-19
**Owner:** Solo dev
**Parent spec:** `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`
**Prior plans (merged):** Plan 1 (foundation & sync), Plan 2a (dashboard API), Plan 2b (dashboard UI), Plan 3 (`/player` route), Plan 4 (deployment).
**Deferred to later plans:** Filesystem bridge / on-disk media cache (Plan 6), audio unmute via MediaSession (Plan 6), OTA APK updates.

## Summary

A standalone Android application that wraps the existing Nuxt `/player` route in a fullscreen WebView kiosk, embeds Tailscale (via the `tsnet` Go library) so each TV joins the operator's tailnet without a second app, auto-launches on boot, and hardens itself against remote-control interference. The APK is a thin shell — all playback, reconciliation, SSE, and telemetry logic remain in the already-shipped web player. Plan 5 makes the player reachable from Android TV hardware over the tailnet with no per-device typing during provisioning.

## Goals

- One APK artifact installs on every TV with zero typing during provisioning.
- TV joins the tailnet on first boot without operator interaction (pre-auth key baked at build).
- Fullscreen kiosk: no system bars, no Android UI chrome, no way for a passerby with a remote to escape the app.
- Boots straight into the player after a power cycle.
- Recovers from WebView or process crashes automatically.
- Remains a thin shell — player iteration continues to happen in the Nuxt codebase and propagates via `WebView.reload()` without rebuilding the APK.

## Non-goals (Plan 5)

- Filesystem bridge (`NativeFS` — `download`, `exists`, `evictExcept`, `fileUrl`, `free`). Deferred to Plan 6. Player continues to fetch media via server URLs.
- Audio unmute via MediaSession. Deferred to Plan 6.
- OTA APK updates. Manual `adb install -r` is the upgrade path for v1.
- Play Store distribution.
- Remote APK push from the dashboard.
- Multi-language UI (the APK's visible surface is splash + error text only).
- Instrumented / Espresso UI tests. Manual QA covers v1.

## Trust model (recap)

- All traffic travels the operator's Tailscale tailnet. No public exposure.
- No authentication on the Lanka API. No HTTPS. `usesCleartextTraffic="true"` in the manifest.
- The baked tailnet auth key is extractable from the APK bytes. Mitigation: an ACL tag (`tag:lanka-kiosk`) restricts these nodes to `signage-server:3000` only; keys are ephemeral and reusable and can be rotated by rebuilding the APK.
- Self-signed release keystore kept out of git; operator backs it up.

## Architecture

One new top-level directory, `android/`, holding a standalone Gradle project. No shared tooling with the Nuxt app — different build system, different language, different release cadence.

```
┌─────────────────────────────────────────────────────────────┐
│  Lanka Kiosk APK (on each Android TV)                       │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────┐     │
│  │ MainActivity    │    │ tsnet (Go, via JNI)         │     │
│  │  - Immersive    │◄───┤  - Auth key (baked)         │     │
│  │  - Kiosk flags  │    │  - Runs as userspace VPN    │     │
│  │  - WebView      │    │  - Exposes SOCKS on :1055   │     │
│  │  - KeyHandler   │    └─────────────────────────────┘     │
│  └────────┬────────┘                                        │
│           │ loads                                           │
│           ▼                                                 │
│  http://lanka-server:3000/player?deviceId=<uuid>            │
│  (via tsnet tunnel — server's tailnet MagicDNS name)        │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────┐     │
│  │ BootReceiver    │    │ SharedPreferences           │     │
│  │  (auto-launch)  │    │  - deviceId (UUID)          │     │
│  └─────────────────┘    │  - serverUrlOverride (opt)  │     │
│                         │  - heartbeatTimestamp       │     │
│                         └─────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

Single-activity app. Three Gradle modules:

| Module | Purpose |
|---|---|
| `:app` | Activity lifecycle, kiosk flags, WebView, key interception, boot receiver, watchdog, storage, UI (splash + override dialog) |
| `:tsnet` | Go cross-compile producing `.so` per ABI + Kotlin JNI wrapper and Android `Service` that owns the tsnet lifecycle and exposes a local SOCKS proxy |
| `:bridge` | Reserved for Plan 6's `NativeFS`. Empty stub in Plan 5 so Plan 6 is a pure addition. |

Clean separation of concerns:
- **Kotlin (`:app`):** activity lifecycle, kiosk flags, key interception, boot launch, WebView container, `SharedPreferences`, long-press escape dialog.
- **Go/tsnet (`:tsnet`):** joins tailnet on launch, proxies WebView traffic. No direct interaction with the WebView — the WebView uses a custom `WebViewClient` that routes requests through the local SOCKS proxy that tsnet exposes.
- **JavaScript (Nuxt `/player`, already shipped):** untouched except for one small composable edit — `useNativeDevice()` detects the native bridge and delegates to it when present. No `NativeFS` work on the Nuxt side in Plan 5; Plan 6 will swap `usePlayerEnv.fileUrl` and add reconciler hooks when the native `NativeFS` ships.

### Stack

- **Language:** Kotlin 1.9 + Go (for the tsnet module).
- **Build:** Gradle 8.x + Android Gradle Plugin 8.x.
- **`minSdk`:** 24 (Android 7). Every sideload-capable Android TV shipping today runs this or newer.
- **`targetSdk` / `compileSdk`:** 34 (Android 14).
- **Libraries:** `androidx.core`, `androidx.webkit`, `androidx.work:work-runtime-ktx`. No Compose; classic Views (only used for the splash and override dialog — the main UI is the WebView).
- **Testing:** JUnit 4 on the JVM for pure-logic classes. No Robolectric, no Espresso.

## Provisioning & first-boot flow

### Build-time

```
gradle.properties (committed, defaults):
  LANKA_SERVER_URL=http://lanka-server:3000
  LANKA_TAILNET_AUTHKEY=   # empty in commit; CI/dev fills in via env var
```

Release build reads both into `BuildConfig` fields. Auth key is an **ephemeral, reusable, pre-auth, tagged** key from the Tailscale admin console:

- **Ephemeral:** nodes drop from the tailnet after being offline for the configured window — no stale node list.
- **Reusable:** one key works for every APK install.
- **Pre-auth:** nodes join without any on-device consent prompt.
- **Tagged** `tag:lanka-kiosk`: ACL restricts these nodes to `signage-server:3000` only; an APK leak hits a dead-end tailnet corner.

The auth key lives in `BuildConfig` in the release APK bytes. Anyone decompiling the APK gets it. Mitigation: tag ACL + ephemeral keys + rotate the key quarterly (rebuild + `adb install -r`). Acceptable for the solo-dev trust model.

### First boot on a fresh TV

1. `adb install lanka-kiosk-release.apk`
2. `adb shell am start -n ai.lanka.kiosk/.MainActivity` (or reboot the TV).
3. OS may prompt "Set as default launcher?" — operator accepts (remote OK, one time).
4. `MainActivity.onCreate`:
   - Generate or read `SharedPreferences` `deviceId` (UUID).
   - Start `TsnetService` with `BuildConfig.LANKA_TAILNET_AUTHKEY`.
   - Show native splash ("Joining tailnet…").
5. tsnet emits a "connected" callback (~2–5 s typical).
6. WebView loads `http://<server-url>/player?deviceId=<uuid>` through the local SOCKS proxy.
7. Server sees a new `deviceId`, auto-creates a `devices` row, device appears in the dashboard's unclaimed tray.
8. Operator claims the device and assigns a playlist via the dashboard.
9. SSE pushes `manifest-changed`; player loads content. Done.

Total operator time on the TV after `adb install`: ~30 s of remote presses for the launcher-picker dialog, then zero interaction. Everything else is automatic.

### Subsequent boots

Same path, no launcher prompt (already default), no claim step (`deviceId` persists). Typical time-to-first-frame from a cold power-on: ~10–20 s (OS boot + WebView init + tsnet handshake + manifest fetch + first video preload).

### Re-provisioning a failed TV

If a TV is bricked, dead, or swapped: `adb install` on the replacement → new UUID → new device row → operator claims it to the same group. Old device row is deleted via the dashboard. No key rotation needed.

## Device identity

**Supersedes** the parent spec's "Android ID on real devices, fallback to stored UUID" language. Plan 5 uses a **UUID-only** strategy on the APK side, matching the player spec's web shim.

Rationale:
- Android ID resets when the APK is re-signed with a different keystore → a lost keystore would look like "every TV is new" to the server.
- Some low-end OEMs return constants or empty strings for Android ID.
- UUID-only has no OEM edge cases and no keystore coupling, and matches the web shim behavior.

Resolution flow (Kotlin, in `DeviceIdStore`):

```
deviceId():
  1. if SharedPreferences contains "deviceId" AND value parses as UUID → return it
  2. id = UUID.randomUUID().toString()
  3. SharedPreferences.edit().putString("deviceId", id).apply()
  4. return id
```

A UUID is generated once per install of the APK on a given TV. It survives regular reboots and app data is normally retained across app updates (`android:allowBackup="false"` does **not** affect update persistence — only cloud backup restore and manifest-declared data extraction). It does **not** survive:
- APK uninstall + reinstall (app data is cleared).
- Factory reset.
- Re-signing the APK with a different keystore (Android treats it as a different app and wipes data).

All three consequences are acceptable and documented in the QA checklist: operator re-claims the device under its new UUID.

## Native bridge contract

The APK injects one JavaScript object into the WebView at page load. The player already consumes `useNativeDevice()` as a Vue composable from Plan 3 — Plan 5 introduces the real native-backed implementation. `NativeFS` is not introduced in Plan 5; it ships with Plan 6.

### `window.NativeDevice` — implemented in Plan 5

Kotlin (in `:app/src/main/kotlin/ai/lanka/kiosk/bridge/NativeDeviceBridge.kt`):

```kotlin
class NativeDeviceBridge(
  private val ctx: Context,
  private val webView: WebView,
  private val deviceIdStore: DeviceIdStore,
  private val serverUrlResolver: ServerUrlResolver
) {
  @JavascriptInterface fun deviceId(): String = deviceIdStore.deviceId()
  @JavascriptInterface fun reload() { webView.post { webView.reload() } }
  @JavascriptInterface fun version(): String {
    val app = BuildConfig.VERSION_NAME
    val os = "Android ${Build.VERSION.RELEASE}"
    val model = "${Build.MANUFACTURER} ${Build.MODEL}"
    return JSONObject(mapOf("app" to app, "os" to os, "model" to model)).toString()
  }
  @JavascriptInterface fun serverUrl(): String = serverUrlResolver.resolve()
}
```

Matching TypeScript interface on the player side (unchanged from Plan 3):

```ts
interface NativeDevice {
  deviceId(): string
  reload(): void
  version(): { app: string; os: string; model: string }
  serverUrl(): string
}
```

`app/composables/player/useNativeDevice.ts` already contains a web shim. Plan 5 adds a runtime capability check: if `window.NativeDevice` is defined, wrap its methods (parsing the JSON returned from `version()`); otherwise fall back to the existing web shim. No TypeScript interface change.

### `window.NativeFS` — not present in Plan 5

The parent spec's `NativeFS` contract (`download`, `exists`, `evictExcept`, `fileUrl`, `free`) is out of scope for Plan 5. The APK does **not** inject `window.NativeFS`, and the player side makes no changes for it. `usePlayerEnv.fileUrl` continues to return `/media/${sha256}`.

Plan 6 will:
- Add the Kotlin `NativeFSBridge` in `:bridge` and inject it as `window.NativeFS`.
- Modify `usePlayerEnv.fileUrl` to prefer `window.NativeFS.fileUrl(sha256)` when present.
- Add `exists` / `download` / `evictExcept` hooks into `useReconciler.ts` before playlist rebuild.

Scoping those diffs into Plan 6 keeps Plan 5's surface area focused on "APK boots, joins tailnet, loads the player."

### Bridge-injection mechanics

`WebView.addJavascriptInterface(bridge, "NativeDevice")` is called in `MainActivity.onCreate()` before the first `loadUrl()`. The `@JavascriptInterface` annotation is mandatory on every exposed method. `@JavascriptInterface` methods can only return primitives and `String` — complex types cross the boundary as JSON strings (hence `version()`'s stringly return).

## Kiosk shell, lifecycle, watchdog

Single `MainActivity` extending `Activity` (not `AppCompatActivity` — no app bar or Material theming needed; the WebView fills the window).

### AndroidManifest

```xml
<application
    android:label="Lanka"
    android:icon="@mipmap/ic_launcher"
    android:allowBackup="false"
    android:usesCleartextTraffic="true">
  <activity
      android:name=".MainActivity"
      android:exported="true"
      android:launchMode="singleTask"
      android:configChanges="orientation|screenSize|keyboardHidden|navigation"
      android:theme="@style/Theme.Lanka.Kiosk"
      android:screenOrientation="landscape">
    <intent-filter>
      <action android:name="android.intent.action.MAIN"/>
      <category android:name="android.intent.category.HOME"/>
      <category android:name="android.intent.category.LEANBACK_LAUNCHER"/>
      <category android:name="android.intent.category.DEFAULT"/>
    </intent-filter>
  </activity>
  <receiver android:name=".BootReceiver" android:exported="true">
    <intent-filter>
      <action android:name="android.intent.action.BOOT_COMPLETED"/>
    </intent-filter>
  </receiver>
</application>

<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
<uses-permission android:name="android.permission.WAKE_LOCK"/>
```

Notes:
- `usesCleartextTraffic="true"` — server is `http://` over tailnet; no TLS. Safe in the trust model.
- `HOME` + `LEANBACK_LAUNCHER` — OS offers Lanka as a launcher pick; `LEANBACK_LAUNCHER` is the Android TV launcher category.
- `configChanges` stops Android from recreating the activity on spurious config events (HDMI handshake, remote pairing).
- `screenOrientation="landscape"` — locked.
- `Theme.Lanka.Kiosk` — fullscreen, black background, no status bar, no action bar.

### `MainActivity.onCreate` sequence

```kotlin
override fun onCreate(s: Bundle?) {
  super.onCreate(s)
  KioskFlags.apply(this)                              // KEEP_SCREEN_ON, immersive, hide system bars
  setContentView(R.layout.activity_main)              // <WebView android:id="@+id/web"/>
  webView = findViewById(R.id.web)
  configureWebView(webView)
  webView.addJavascriptInterface(
    NativeDeviceBridge(this, webView, deviceIdStore, serverUrlResolver),
    "NativeDevice",
  )
  webView.loadUrl("about:blank")
  splash.show("Joining tailnet…")
  TsnetService.startAndWait(this, BuildConfig.LANKA_TAILNET_AUTHKEY) { ok ->
    if (!ok) { splash.show("Tailnet failed — will retry"); return@startAndWait }
    val url = serverUrlResolver.resolve() + "/player?deviceId=" + deviceIdStore.deviceId()
    webView.loadUrl(url)
    splash.hide()
  }
  WatchdogWorker.schedule(this)
  HeartbeatWriter.start(this)                         // writes SharedPreferences every 30s
}
```

### Kiosk flags (`KioskFlags.apply`)

- `window.addFlags(FLAG_KEEP_SCREEN_ON)` — the TV never dims.
- Immersive sticky: `windowInsetsController.hide(systemBars())`, `behavior = BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`.
- `setDecorFitsSystemWindows(false)` — WebView fills the entire display including notch/overscan.
- No action bar (`Theme.Lanka.Kiosk` derives from a `NoActionBar` parent).

### Key interception

```kotlin
override fun dispatchKeyEvent(event: KeyEvent): Boolean {
  return when (event.keyCode) {
    KeyEvent.KEYCODE_BACK,
    KeyEvent.KEYCODE_DPAD_CENTER,
    KeyEvent.KEYCODE_DPAD_UP,
    KeyEvent.KEYCODE_DPAD_DOWN,
    KeyEvent.KEYCODE_DPAD_LEFT,
    KeyEvent.KEYCODE_DPAD_RIGHT,
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
    KeyEvent.KEYCODE_MENU -> { longPressDetector.onKey(event); true }
    else -> super.dispatchKeyEvent(event)   // volume, etc. pass through
  }
}
```

HOME cannot be intercepted at the app level. It's mitigated by declaring the APK as a launcher (`category.HOME` + `category.LEANBACK_LAUNCHER`): the operator picks Lanka as the default launcher on first boot, and every subsequent reboot goes straight into the kiosk.

`LongPressDetector` consumes D-pad CENTER events: a 5-second hold on the native splash/standby screen fires the override dialog callback. Once the WebView has loaded the player, `dispatchKeyEvent` swallows the key before the detector sees it, so the escape hatch is only reachable during connect/error states.

### WebView configuration

```kotlin
webView.settings.apply {
  javaScriptEnabled = true
  domStorageEnabled = true
  mediaPlaybackRequiresUserGesture = false
  cacheMode = WebSettings.LOAD_DEFAULT
  userAgentString = "$defaultUserAgent LankaKiosk/${BuildConfig.VERSION_NAME}"
}
webView.setBackgroundColor(Color.BLACK)
webView.webViewClient = LankaWebViewClient(socksProxy)
webView.webChromeClient = LankaChromeClient()       // forwards console.log to logcat
```

`LankaWebViewClient` overrides `shouldInterceptRequest` to dial the server through the tsnet-exposed SOCKS proxy at `localhost:1055`. No system-wide VPN; only WebView traffic is tunneled.

### `BootReceiver`

```kotlin
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, i: Intent) {
    if (i.action != Intent.ACTION_BOOT_COMPLETED) return
    val launch = Intent(ctx, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    ctx.startActivity(launch)
  }
}
```

Redundant with the HOME-launcher declaration but covers the pre-launcher-picked first-boot case.

### Watchdog — `WatchdogWorker`

- `androidx.work.WorkManager` `PeriodicWorkRequest`, 15-minute interval (WorkManager's minimum).
- `MainActivity` writes a heartbeat timestamp to `SharedPreferences` every 30 s via `HeartbeatWriter`.
- Worker reads the heartbeat; if older than 5 minutes, restarts `MainActivity` via `startActivity(FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK)`.
- Handles silent WebView process death, Activity OOM kills, tsnet service death.
- Not the fastest recovery (up to 15 min) but dirt-simple, reliable, and battery-cheap. A shorter interval is available via `setPeriodicWorkPolicy` but is not justified for wall-powered TVs in v1.

### Server URL override (escape hatch)

On the splash/standby screen, a 5-second hold of D-pad CENTER opens a native `OverrideDialog`:

- Two fields: **Server URL** (prefilled with currently resolved value) and **Device ID** (prefilled, read-only — display for diagnostic handoff).
- Two buttons: **Apply** (stores to `SharedPreferences`, triggers `MainActivity.recreate()`), **Reset** (clears the override; resolver falls back to `BuildConfig.LANKA_SERVER_URL`).

Security is zero theater: anyone with `adb` can write whatever they want to the device. The 5-second hold just prevents accidental triggers by a passerby with the remote.

## File layout

```
lanka/
├── android/                              # NEW — standalone Gradle project
│   ├── app/
│   │   ├── build.gradle.kts
│   │   ├── proguard-rules.pro
│   │   └── src/
│   │       ├── main/
│   │       │   ├── AndroidManifest.xml
│   │       │   ├── kotlin/ai/lanka/kiosk/
│   │       │   │   ├── MainActivity.kt
│   │       │   │   ├── BootReceiver.kt
│   │       │   │   ├── LankaWebViewClient.kt
│   │       │   │   ├── LankaChromeClient.kt
│   │       │   │   ├── bridge/
│   │       │   │   │   └── NativeDeviceBridge.kt
│   │       │   │   ├── kiosk/
│   │       │   │   │   ├── KeyEventHandler.kt
│   │       │   │   │   ├── LongPressDetector.kt
│   │       │   │   │   └── KioskFlags.kt
│   │       │   │   ├── storage/
│   │       │   │   │   ├── DeviceIdStore.kt
│   │       │   │   │   ├── ServerUrlResolver.kt
│   │       │   │   │   └── HeartbeatStore.kt
│   │       │   │   ├── watchdog/
│   │       │   │   │   ├── HeartbeatWriter.kt
│   │       │   │   │   └── WatchdogWorker.kt
│   │       │   │   └── ui/
│   │       │   │       ├── SplashView.kt
│   │       │   │       └── OverrideDialog.kt
│   │       │   └── res/
│   │       │       ├── layout/activity_main.xml
│   │       │       ├── values/{strings,styles,colors}.xml
│   │       │       └── mipmap-*/ic_launcher.png
│   │       └── test/
│   │           └── kotlin/ai/lanka/kiosk/
│   │               ├── storage/DeviceIdStoreTest.kt
│   │               ├── storage/ServerUrlResolverTest.kt
│   │               ├── storage/HeartbeatStoreTest.kt
│   │               ├── kiosk/KeyEventHandlerTest.kt
│   │               └── kiosk/LongPressDetectorTest.kt
│   ├── tsnet/                            # Go cross-compile + JNI + Android Service
│   │   ├── build.gradle.kts              # invokes `go build` per ABI into jniLibs
│   │   ├── src/main/go/lanka_tsnet.go    # tsnet wrapper exported over CGO
│   │   └── src/main/kotlin/ai/lanka/tsnet/
│   │       ├── TsnetService.kt
│   │       └── SocksProxy.kt
│   ├── bridge/                           # STUB module for Plan 6's NativeFS
│   │   └── build.gradle.kts
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   ├── gradle.properties                 # defaults for LANKA_SERVER_URL
│   ├── gradle/wrapper/
│   ├── gradlew, gradlew.bat
│   └── README.md                         # build, install, QA
│
├── app/composables/player/
│   └── useNativeDevice.ts                # MODIFIED: detect window.NativeDevice
│
└── .gitignore                            # MODIFIED: /android/.gradle/, **/build/, *.jks, *.apk
```

### Nuxt-side diffs in Plan 5

1. `app/composables/player/useNativeDevice.ts` — add `window.NativeDevice` capability check; when present, call the native methods (parsing `version()`'s JSON) and fall back to the existing web shim otherwise.
2. Vitest coverage for both branches of `useNativeDevice` (bridge present vs. absent).
3. Parent spec `2026-04-18-lanka-digital-signage-design.md` gets a short "Superseded by Plan 5 — see `2026-04-19-lanka-apk-kiosk-design.md` §Device identity" note above its device-identity paragraph.

`usePlayerEnv.fileUrl`, `useReconciler`, `PlayerStage.vue`, and every other player file are **not** touched in Plan 5.

## Testing

### Unit tests (JVM, plain JUnit 4)

| Module | Cases |
|---|---|
| `DeviceIdStore` | First call generates a UUID; second call returns the same UUID; corrupt stored value regenerates; persistence survives instance reconstruction |
| `ServerUrlResolver` | `BuildConfig` used when no override; override wins when set; clearing override restores default |
| `KeyEventHandler` | Swallows BACK / D-pad / play-pause / MENU; passes through VOLUME_UP/DOWN/MUTE and other keys |
| `LongPressDetector` | Fires callback only after full 5 s hold; cancels on key-up; cancels if a different key interleaves |
| `HeartbeatStore` | Write + read round-trip; stale detection at the 5-minute threshold |

No Robolectric. No instrumented tests. Runs in `./gradlew test`.

### Player-side unit tests (vitest, existing stack)

- `useNativeDevice` — bridge-present branch invokes native methods, parses `version()` JSON; bridge-absent branch uses the existing web shim.

### Manual QA checklist (documented in `android/README.md`)

1. Fresh install → first boot → launcher-picker prompt → accept Lanka → splash → "Joining tailnet…" → tsnet connects → WebView loads → device appears in the unclaimed tray.
2. Assign a playlist → player shows content within ~5 s via SSE.
3. Reboot TV → cold-boot time-to-first-frame ≤ 20 s, no launcher prompt second time.
4. `adb shell am force-stop ai.lanka.kiosk` → watchdog restarts `MainActivity` within 15 min → playback resumes.
5. Disconnect network for 60 s → player shows `<StandbyScreen>` → reconnect → player recovers.
6. D-pad + BACK + MENU presses during playback → no visible effect.
7. VOLUME keys during playback → system volume adjusts (playback muted in Plan 5).
8. Long-press D-pad CENTER during splash/standby (5 s) → override dialog appears; set bogus URL → Apply → splash reappears pointing at bogus URL; Reset → restores `BuildConfig` default.
9. `adb uninstall` + reinstall → new UUID → operator re-claims. Documented consequence.
10. Re-sign APK with a different keystore + reinstall → `SharedPreferences` wiped by Android → new UUID → operator re-claims. Documented consequence; keystore backup is called out in the README.

## Build & release workflow

```bash
cd android

# one-time: self-signed keystore, kept OUT of git
keytool -genkey -v -keystore lanka-release.jks -alias lanka \
  -keyalg RSA -keysize 2048 -validity 10000
# BACK THIS UP. Losing it means every TV must reinstall.

# env vars (direnv, shell profile, or CI secrets):
export LANKA_KEYSTORE_PATH=/abs/path/to/lanka-release.jks
export LANKA_KEYSTORE_PASS=...
export LANKA_KEY_ALIAS=lanka
export LANKA_KEY_PASS=...
export LANKA_TAILNET_AUTHKEY=tskey-auth-xxxxx      # Tailscale admin console
export LANKA_SERVER_URL=http://lanka-server:3000   # override gradle.properties if needed

./gradlew assembleRelease
# output: android/app/build/outputs/apk/release/app-release.apk

# install on a TV (over ADB-over-network):
adb connect <tv-ip>:5555
adb install -r app-release.apk
```

## Open questions / deferred

- **FS bridge (Plan 6):** on-disk media cache via `WebViewAssetLoader` + `NativeFS` bridge, with `evictExcept` and atomic downloads. Player-side integration (capability check in `usePlayerEnv.fileUrl`, reconcile-loop hooks) ships in Plan 6 alongside the native bridge.
- **Audio unmute (Plan 6):** requires MediaSession handling in the APK. Silent playback is the Plan 5 baseline.
- **OTA APK updates:** revisit once total device count exceeds ~10.
- **Faster watchdog:** if 15-minute recovery windows become a pain, replace `WorkManager` with a foreground service + `JobScheduler`. Acceptable to defer.
- **Keystore rotation procedure:** documented as a side-note in `android/README.md`. Automation deferred.
