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

9. **Caches media on local storage** so videos replay from disk instead of
   re-fetching over the tailnet every loop. `LankaWebViewClient.shouldInterceptRequest`
   (→ `MediaCache`) transparently intercepts `/media/<sha256>` requests:
   - **cache hit** → served from `filesDir/media-cache/<sha>` with full HTTP
     Range support (so `<video>` seeks/loops play locally, no network);
   - **cache miss** → request goes to the network as usual and the file is
     downloaded in the background for the next loop.

   Media is content-addressed (immutable), so cached files never go stale. Disk
   is bounded by a **2 GB LRU cap** (`MediaCache.MAX_BYTES`); least-recently-used
   files are evicted first. The web player is unchanged — it requests the same
   `/media/<sha>` URLs, so the cache is invisible to it (and a desktop browser
   simply always uses the network for QA).

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
- **Media cache is best-effort, not a prefetch.** The *first* loop of each new
  item still streams from the server (then it's cached); there's no upfront
  download of the whole playlist. Cap is a fixed 2 GB LRU — a playlist larger
  than that degrades to per-loop network for the overflow.
- **Cleartext HTTP allowed** (`usesCleartextTraffic="true"`) so plain
  `http://` server URLs work over the tailnet without TLS.

## Uninstall

```bash
adb uninstall ai.lanka.kiosk
```

…or via the TV's app settings.
