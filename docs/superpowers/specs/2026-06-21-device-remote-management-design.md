# Device Remote Management — Design Spec
**Date:** 2026-06-21
**Scope:** Plan 7 — persistent WebSocket command channel + OTA APK updates + remote diagnostics

## Background

Lanka TVs (cheap Amlogic Android boxes) cannot run Tailscale due to a broken Android keystore. The existing architecture is TV-initiated only: the box polls the server every 30 s and maintains a one-way SSE connection (`/api/devices/:id/stream`) for content-sync kicks. This means the server cannot reach the box to push APK updates, trigger reboots, capture screenshots, or pull logs.

The standard industry solution (used by Yodeck, Screenly, BrightSign) is a **persistent outbound WebSocket** from the device. The server writes commands down the open socket; the device executes them and sends acknowledgements back. No VPN required.

## Goals

- Remote APK OTA updates (silent, no user interaction)
- Remote player restart (app-level, not OS reboot)
- Remote screenshot capture
- Remote log pull
- Command status tracking (pending → sent → acked/failed) durable across server restarts and device offline periods

## Non-Goals

- OS-level device reboot (requires root/system permission — not available on target hardware)
- Real-time video stream from device
- Replacing the existing SSE channel (it stays untouched for content sync)
- WireGuard / VPN of any kind

## Architecture

```
Dashboard UI
    │  POST /api/apk/upload
    │  POST /api/devices/:id/commands
    │  GET  /api/devices/:id/commands
    ▼
Server: CommandHub + DB command queue
    │  WebSocket /api/devices/:id/ws
    ▼
Player JS: useCommandChannel composable
    │  NativeFS.downloadApk / installApk / screenshot / getLogs
    ▼
Android APK: OtaInstaller + extended NativeFSBridge
```

The SSE channel and `useReconciler.ts` are **untouched**. The WebSocket is a parallel connection purely for management.

## Data Model

One Drizzle migration adds two new tables and one new column on `devices`:

```ts
// APK releases — uploaded by admin, referenced by OTA commands
apk_releases: {
  id:          serial pk
  version:     text not null          // "1.2.3", display label only
  sha256:      text not null unique   // content address; file in media-store
  size:        integer not null       // bytes
  uploaded_at: integer not null       // unix ms
  uploaded_by: integer references users(id)
}

// New column on existing devices table
devices: {
  apk_version: text nullable   // last reported APK version from telemetry; null if never reported
}

// Command queue — durable delivery to devices
device_commands: {
  id:         serial pk
  device_id:  text not null references devices(id)
  cmd:        text not null           // 'ota' | 'reboot' | 'screenshot' | 'log-request'
  payload:    text                    // JSON, cmd-specific
  status:     text not null           // 'pending' | 'sent' | 'acked' | 'failed'
  result:     text                    // JSON returned by device (base64 screenshot, log text, error)
  created_at: integer not null
  updated_at: integer not null
}
```

**Status transitions:**
- `pending` → `sent`: device WebSocket connects, command delivered
- `sent` → `acked` / `failed`: device sends acknowledgement
- `sent` → `pending`: device disconnects before acking (re-queued for next connect)

**APK storage:** files go into the existing `useMediaStore()` under their sha256 (same LocalDisk/R2 mechanism as media). No new storage layer.

## Server Components

### CommandHub service (`server/services/command-hub.ts`)

Singleton (mirrors `EventsHub` pattern):

```ts
class CommandHub {
  // active WebSocket connections
  private connections: Map<string, WebSocket>

  // Insert DB row, push immediately if device is connected
  enqueue(db, deviceId, cmd, payload): Promise<number>  // returns commandId

  // Called on WS open — flush all pending commands for this device
  drain(db, deviceId, ws): Promise<void>

  // Called on WS message — update DB row, emit dashboard event
  handleAck(db, deviceId, commandId, status, result): Promise<void>

  // Called on WS close — re-queue any 'sent' rows back to 'pending'
  onDisconnect(db, deviceId): Promise<void>
}
```

### New API Endpoints

```
server/api/devices/[id]/ws.get.ts          WebSocket upgrade (defineWebSocketHandler)
server/api/devices/[id]/commands.post.ts   Enqueue command (admin/super only)
server/api/devices/[id]/commands.get.ts    List recent commands + status

server/api/apk/index.get.ts                List APK releases
server/api/apk/upload.post.ts              Upload APK binary (multipart, admin/super)
server/api/apk/[id].delete.ts             Delete release + remove from media-store
server/api/apk/[id]/download.get.ts        Stream APK file (auth-gated, not public CDN)
```

### WebSocket Lifecycle (`ws.get.ts`)

```
open   → register in CommandHub, call drain()
message→ parse { commandId, status, result } → handleAck()
close  → onDisconnect() (re-queues sent→pending)
error  → same as close
```

Server sends a `{ cmd: 'ping' }` every 30 s to detect dead connections.

### Message Protocol

Both directions use JSON:

```ts
// server → device
{ commandId: number, cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request', payload?: object }

// ota payload
{ releaseId: number, url: string, sha256: string, version: string }

// device → server
{ commandId: number, status: 'acked' | 'failed', result?: string }
```

## Player JS

### `useCommandChannel.ts` (new composable)

```ts
interface CommandChannelDeps {
  deviceId: string
  nativeFS?: NativeFSBridge   // undefined in browser/non-APK
  onReload: () => void        // from useNativeDevice
}

interface CommandChannelHandle {
  open(): void
  close(): void
}
```

Opened inside `usePlayerBoot.boot()` alongside `reconciler.openStream()`.

**Reconnect:** uses existing `backoff.ts` with the same cap/reset logic as the reconciler.

**Command dispatch:**

| `cmd` | Handler | Ack payload |
|---|---|---|
| `ota` | `NativeFS.downloadApk(url, sha256)` → `NativeFS.installApk(sha256, commandId)` | `{ status: 'acked' }` on install success — fired async via `window.__otaResult` callback |
| `reboot` | `onReload()` (or `location.reload()` if no NativeFS) | none — page reloads; server marks `acked` immediately on delivery |
| `screenshot` | `NativeFS.screenshot()` → base64 JPEG | `{ status: 'acked', result: base64 }` |
| `log-request` | `NativeFS.getLogs()` → string | `{ status: 'acked', result: logText }` |

**Graceful degradation:** if `NativeFS` is absent, `ota`/`screenshot`/`log-request` ack with `{ status: 'failed', result: 'not supported' }`. Works in browser dev.

## Android APK

### New `OtaInstaller.kt`

```kotlin
// Downloads APK to filesDir/apk-cache/<sha256>.apk
// Reuses tmp-rename pattern from MediaCache.downloadSync()
fun downloadApk(sha256: String, url: String): Boolean

// Silent install via PackageInstaller.Session
// Requires Device Owner mode (set once via ADB: dpm set-device-owner ai.lanka.kiosk/.BootReceiver)
// On completion, fires window.__otaResult(commandId, status) via webView.evaluateJavascript()
fun installSilently(sha256: String, commandId: Long, webView: WebView)
```

### New `NativeFSBridge` methods

| Method | Implementation |
|---|---|
| `downloadApk(url, sha256): Boolean` | `OtaInstaller.downloadApk()` |
| `installApk(sha256, commandId): Boolean` | `OtaInstaller.installSilently()` — async, result via `window.__otaResult` |
| `screenshot(): String` | `PixelCopy.request(window, bitmap)` → JPEG → Base64 (API 26+, Amlogic safe) |
| `getLogs(): String` | `Runtime.exec("logcat -d -t 200 -s LankaKiosk:* LankaCache:* NativeFS:*")` |
| `getAppVersion(): String` | `BuildConfig.VERSION_NAME` |

### OTA install result callback

```
PackageInstaller commits
  → OS fires OtaInstallReceiver (BroadcastReceiver)
    → OtaInstaller notifies MainActivity via callback
      → MainActivity.runOnUiThread {
          webView.evaluateJavascript(
            "window.__otaResult($commandId, '$status')", null)
        }
  → useCommandChannel picks up window.__otaResult
  → sends WS ack { commandId, status: 'acked'|'failed' }
```

### AndroidManifest.xml additions

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

<receiver android:name=".BootReceiver" android:exported="true">
  <!-- stub for: adb shell dpm set-device-owner ai.lanka.kiosk/.BootReceiver -->
</receiver>

<receiver android:name=".OtaInstallReceiver" android:exported="false">
  <!-- PackageInstaller install result callbacks -->
</receiver>
```

### Device Owner setup (one-time per box, during initial deployment)

```bash
# Before locking down kiosk, while ADB is connected:
adb shell dpm set-device-owner ai.lanka.kiosk/.BootReceiver
```

After this, `PackageInstaller` installs APKs silently with no user interaction.

## Dashboard UI

### New page: `app/pages/apk.vue`

- APK releases management (nav entry in admin sidebar)
- File upload (drag-and-drop or picker), upload progress bar
- Releases table: version, sha256 prefix, size, date, delete button

### Extended: `app/pages/devices/[id].vue`

New "Remote Control" card:

```
┌─ Remote Control ──────────────────────────────────────┐
│  APK version: 1.1.0   [Push OTA ▾]                   │
│                                                        │
│  [Reboot device]  [Screenshot]  [Pull logs]           │
│                                                        │
│  Recent commands                                       │
│  ─────────────────────────────────────────────────    │
│  ota v1.2.0     ● acked    2 min ago                  │
│  screenshot     ● acked    5 min ago    [view]        │
│  reboot         ● sent     8 min ago                  │
│  log-request    ● failed   1 hr ago     [view error]  │
└───────────────────────────────────────────────────────┘
```

- **Push OTA**: release picker dropdown → confirm dialog → POST command
- **Screenshot**: enqueue → poll → show base64 thumbnail when acked
- **Pull logs**: enqueue → modal `<pre>` when acked
- **Reboot device**: confirm → enqueue reboot. Asks the box for a real OS
  reboot (`DevicePolicy.reboot`, **device-owner only**) and degrades to a
  player reload elsewhere. Deliberately *not* the same control as the header's
  **Reload player** (`POST /api/devices/:id/reload` → SSE), which only ever
  reloads the player — the two coincide on a non-device-owner box, so the
  labels name their target (player vs device) and the confirm text states the
  fallback.

### Telemetry extension

`POST /api/devices/:id/telemetry` body gains optional `apkVersion?: string`. `NativeFSBridge.getAppVersion()` (returns `BuildConfig.VERSION_NAME`) supplies it. Stored in `devices.apk_version` (added in the same migration as `apk_releases` / `device_commands`). Displayed in the device card so the dashboard can show which boxes are behind and need an OTA push.

## Error Handling

- **Device offline when command enqueued**: row stays `pending`, delivered on next WS connect (no TTL — commands persist until acked or manually cancelled)
- **OTA download fails**: `downloadApk` returns false → JS sends `{ status: 'failed', result: 'download error' }` immediately, no install attempted
- **PackageInstaller fails**: `OtaInstallReceiver` fires with error code → `window.__otaResult(commandId, 'failed')` → WS ack with error
- **Screenshot on non-APK**: returns `{ status: 'failed', result: 'not supported' }` immediately
- **WS disconnect mid-command**: `sent` rows re-queued to `pending` on next connect — idempotent for screenshot/log-request; OTA is idempotent too (sha256 guards duplicate downloads)

## Testing

- **Server**: unit tests for `CommandHub` (enqueue, drain, ack, reconnect re-queue) mirroring `events.ts` test patterns; API handler tests for command endpoints
- **Player JS**: unit tests for `useCommandChannel` with mock WebSocket + mock NativeFSBridge; test graceful degradation (no NativeFS)
- **Android**: JVM unit tests for `OtaInstaller.downloadApk` using `OtaInstaller.forTesting(dir)` pattern (mirrors `MediaCache.forTesting`)
- **Integration**: manual test with ADB + Device Owner set on a real box
