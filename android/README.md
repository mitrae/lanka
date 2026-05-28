# Lanka Kiosk APK — proof of concept

Minimal Android APK that opens the Lanka `/player` page in a fullscreen WebView.
Tailscale is a **separate** install (official app from Play Store / sideload),
not embedded. No kiosk protection, no boot intercept, no watchdog — that's the
full Plan 5 scope. See `docs/superpowers/plans/2026-04-19-lanka-apk-kiosk.md`
for the eventual production design.

## What it does

1. Generates and persists a UUID `deviceId` on first run (SharedPreferences).
2. Opens `${LANKA_SERVER_URL}/player?deviceId=<uuid>` in a fullscreen WebView.
3. Hides system bars, keeps the screen on, suppresses the back action via
   `singleTask` (no key intercept beyond Android's defaults).
4. Forwards WebView `console.*` to logcat under tag `LankaPlayer`.

That's it.

## Prerequisites (build host)

- JDK 17+
- Android SDK with `platform-tools`, `build-tools;34.0.0`, `platforms;android-34`
  (install via `sdkmanager`)
- `ANDROID_HOME` env var pointing at the SDK root

The Gradle wrapper handles Gradle itself — no system Gradle needed once
`gradlew` is generated.

## Build

```bash
cd android
./gradlew :app:assembleDebug -PLANKA_SERVER_URL=http://lanka-server:3000
```

Replace `lanka-server:3000` with whatever hostname your TVs can reach over
the tailnet. Tailscale MagicDNS names work (`http://lanka-server:3000`), as
do raw 100.x.y.z IPs.

APK lands at `app/build/outputs/apk/debug/app-debug.apk` (~1.5 MB).

To change the URL, rebuild — there is no on-device override in the PoC.

## On the TV (one-time setup)

1. **Enable Developer options + USB debugging** (or "Apps from unknown sources").
2. **Install Tailscale** — official app from Play Store, or sideload its APK.
   Sign in, confirm the TV appears in your tailnet admin panel.
3. **Sideload the Lanka APK** — copy `app-debug.apk` to a USB stick, plug into
   the TV, install via a file manager. Alternatively over ADB:
   ```bash
   adb connect <tv-ip>:5555
   adb install -r app-debug.apk
   ```
4. Open **Lanka** from the launcher. Splash → WebView loads `/player`.
   The device appears in the Lanka dashboard's unclaimed tray; assign a
   playlist there.

## Known limitations (intentional, PoC scope)

- **No autostart on boot** — user opens the app manually each power-on.
- **No watchdog** — if the WebView crashes, the activity stays on a blank
  screen until user opens the app again.
- **No key handling** — pressing BACK, HOME etc. behaves like a normal app:
  back exits the activity, HOME goes to launcher.
- **No URL override on device** — wrong URL = rebuild APK.
- **Cleartext HTTP allowed** (`usesCleartextTraffic="true"`) so plain
  `http://` server URLs work over the tailnet without TLS.

## Uninstall

```bash
adb uninstall ai.lanka.kiosk
```

…or via the TV's app settings.
