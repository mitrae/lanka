# Lanka Kiosk APK — proof of concept

Minimal Android APK that opens the Lanka `/player` page in a fullscreen WebView.
Tailscale is a **separate** install (official app from Play Store / sideload),
not embedded — and intentionally stays that way (no embedded `tsnet`). The thin
shell now includes the small bits of unattended hardening that an always-on box
actually needs; the heavier Plan 5 ideas (embedded tsnet, WorkManager watchdog,
full D-pad interception, on-screen override dialog) are deliberately **not**
built. See `docs/superpowers/plans/2026-04-19-lanka-apk-kiosk.md` for the
original production design.

## What it does

1. Generates and persists a UUID `deviceId` on first run (SharedPreferences).
2. Opens `${LANKA_SERVER_URL}/player?deviceId=<uuid>` in a fullscreen WebView.
3. Hides system bars and keeps the screen on.
4. Forwards WebView `console.*` to logcat under tag `LankaPlayer`.

### Unattended self-recovery (so a box doesn't go dark and stay dark)

5. **Auto-launches after a reboot** via a `BOOT_COMPLETED` receiver, so a power
   cut / overnight power-off / OS-update reboot brings the player back with no
   human present. (See the autostart caveat under *Known limitations*.)
6. **Retries a failed page load** with capped backoff (3 → 6 → 12 → 24 → 30 s):
   if the server or tailnet isn't ready at launch, or drops briefly, the WebView
   reloads itself instead of sitting on a blank error page.
7. **Recovers from WebView renderer death** (`onRenderProcessGone`): an OOM or
   codec crash during long video playback rebuilds the kiosk instead of letting
   the OS kill the Activity to a black screen.
8. **Swallows the BACK key** so a stray remote press can't drop the kiosk to the
   launcher.

### On-device media cache

9. **Pre-downloads media before playback** via the `NativeFS` JavaScript bridge
   (`NativeFSBridge.kt` → `window.NativeFS`). When a new playlist version arrives:
   - The player reconciler calls `NativeFS.download(sha256, cdnUrl)` for each
     uncached item — blocking until done — then emits the manifest.
   - `usePlayerEnv.fileUrl` returns a `file://` local path when the file is
     cached, so the player reads from disk with no network involvement.
   - `NativeFS.evictExcept(sha256List)` removes files no longer in the playlist.
   - **Storage guard**: download is skipped (falls back to streaming) if
     `StatFs.availableBytes` is known and smaller than the file's `Content-Length`.

10. **Transparent cache-aside interceptor** (`MediaCache`) remains as a safety
    net: any `/media/<sha256>` request that reaches the network is cached in the
    background with full HTTP Range support (so `<video>` seeks work from disk on
    subsequent loops). Media is content-addressed — cached files never go stale.
    Disk is bounded by a **2 GB LRU cap**.

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

## Release build (signed)

Signing creds are read from `android/keystore.properties` (kept **out of git**),
or the `LANKA_KEYSTORE_PATH` / `LANKA_KEYSTORE_PASS` / `LANKA_KEY_ALIAS` /
`LANKA_KEY_PASS` env vars for CI. With neither present, `assembleRelease`
produces an *unsigned* APK.

One-time: create a self-signed keystore and point `keystore.properties` at it.

```bash
cd android
keytool -genkeypair -v -keystore lanka-release.jks -storetype PKCS12 \
  -alias lanka -keyalg RSA -keysize 2048 -validity 10000
cat > keystore.properties <<'EOF'
storeFile=lanka-release.jks
storePassword=<your-store-pass>
keyAlias=lanka
keyPassword=<your-key-pass>
EOF
```

**Back up `lanka-release.jks` + `keystore.properties` together.** Losing the
keystore means every box must uninstall/reinstall (a different signature can't
`-r` upgrade and Android wipes the app's stored `deviceId`).

```bash
./gradlew :app:assembleRelease -PLANKA_SERVER_URL=http://lanka-server:3000
# → app/build/outputs/apk/release/app-release.apk  (verify: apksigner verify <apk>)
```

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

- **Autostart depends on the box.** A `BOOT_COMPLETED` receiver relaunches the
  app after a reboot, but Android 10+ restricts background activity launches, so
  some boxes won't honor it. The robust fallback on a single-purpose box is to
  set Lanka as the device's **HOME launcher** (it then boots straight into the
  player and BACK/HOME return to it for free). Keep Tailscale reachable for
  sign-in before doing this.
- **HOME is not intercepted** — only BACK is swallowed. Pressing HOME on a box
  where Lanka isn't the launcher goes to the launcher (use the HOME-launcher
  setup above to close that gap).
- **Renderer recovery is not total-crash recovery.** `onRenderProcessGone`
  rebuilds the kiosk when the WebView *renderer* dies, but a full app-process
  kill (true OOM) still relies on autostart/HOME-launcher to relaunch.
- **No URL override on device** — wrong/changed server URL = rebuild APK. (A
  cheap `adb am start --es serverUrl …` override is a candidate next step.)
- **Sleep/wake (goal 3) is not implemented** — an unprivileged app can't power
  the TV panel off (HDMI-CEC is privileged); see the audit notes for the
  scheduled-blank-screen + smart-plug approach.
- **Syncing overlay doesn't render during downloads.** `NativeFS.download()` is
  synchronous from JavaScript's perspective and blocks the JS thread, so Vue
  cannot flush DOM updates while downloads run. The `syncing` reactive state is
  wired but has no visible effect until async downloads are implemented.
- **Cache LRU cap is 2 GB.** A playlist larger than that degrades the overflow
  items to per-loop streaming via the cache-aside interceptor.
- **Cleartext HTTP allowed** (`usesCleartextTraffic="true"`) so plain
  `http://` server URLs work over the tailnet without TLS.

## Manual QA checklist — offline media cache

Run after installing a fresh APK build with `NativeFSBridge` wired:

1. **NativeFS bridge present**
   ```bash
   # Open chrome://inspect, select the WebView, run in console:
   typeof window.NativeFS   # → "object"
   window.NativeFS.free()   # → positive number (bytes available)
   ```

2. **Files downloaded after playlist assignment**
   - Assign a playlist via the dashboard.
   - Wait for the player to load content (~5–30 s depending on file sizes).
   ```bash
   adb shell ls /data/data/ai.lanka.kiosk/files/media-cache/
   # → sha256 filenames (64 hex chars) for each media item
   ```

3. **Player uses local file:// URLs after download**
   - In WebView console: `window.NativeFS.exists('<sha256>')` → `true`
   - `window.NativeFS.fileUrl('<sha256>')` → `file:///data/…/media-cache/<sha>`

4. **Offline playback** — disconnect WiFi after first sync
   - Turn off WiFi on the TV (or disconnect the router).
   - Verify content keeps playing without interruption.
   - Re-enable WiFi; verify player is still functional.

5. **Eviction on playlist change**
   - Assign a different playlist.
   - After the new files download, verify old sha256 files are gone:
   ```bash
   adb shell ls /data/data/ai.lanka.kiosk/files/media-cache/
   # → only sha256s from the new playlist
   ```

6. **Storage guard** (manual, requires a near-full device)
   - Fill internal storage to near capacity, then assign a new playlist.
   - Check logcat for `LankaCache skipping download`: the player falls back
     to streaming for items it couldn't cache.
   ```bash
   adb logcat -s LankaCache:W
   ```

7. **No stale .tmp files after clean run**
   ```bash
   adb shell ls /data/data/ai.lanka.kiosk/files/media-cache/ | grep '\.tmp'
   # → empty
   ```

8. **No stale .tmp files after forced kill during download**
   - During active download, run `adb shell am force-stop ai.lanka.kiosk`.
   - Relaunch: `adb shell am start -n ai.lanka.kiosk/.MainActivity`
   - After relaunch, verify `.tmp` files are cleaned up by `MediaCache.init`.

## Uninstall

```bash
adb uninstall ai.lanka.kiosk
```

…or via the TV's app settings.
