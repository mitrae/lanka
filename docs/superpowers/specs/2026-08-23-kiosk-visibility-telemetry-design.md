# Kiosk visibility telemetry — is the player actually on screen?

**Date:** 2026-08-23
**Status:** Design approved; revised 2026-08-23 after Codex review (lifecycle inputs, fail-safe initial state, episode-scoped debounce and probe window, edge-triggered posting, coupled package semantics)
**Related:** `2026-06-21-device-remote-management-design.md` (telemetry + command channel), `2026-06-28-lanka-native-exoplayer-flavor-design.md` (shared source sets / both flavors), `2026-08-23-kiosk-pin-unlock-design.md` (`KioskLock`, `KioskPin` — the pure-core pattern this follows)

## Summary

Teach the player to report **whether it is actually on screen**, and surface that
in the dashboard. Three states (`foreground` / `obscured` / `background`), three
counters (snap-backs, focus losses, hidden time), and — where the appop allows —
the package name of whatever took the screen.

The Android state machine lives in `android/app/src/main/`, so **both** flavors
inherit one implementation. The transport is the existing telemetry endpoint,
extended with optional fields and given a 30 s heartbeat.

## Motivation

Today the dashboard cannot tell a playing TV from a TV that is running Lanka
behind someone else's app. Worse, two existing signals actively lie:

1. **Liveness comes from the manifest poll, not from being on screen.**
   `GET /api/devices/:id/manifest` stamps `lastSeenAt` (`manifest.get.ts:37`), and
   neither `MainActivity` nor `PlayerActivity` overrides `onPause`/`onStop` to
   call `webView.onPause()`. So the WebView's JS timers keep running while the
   Activity is stopped, the 30 s poll keeps firing, and a fully-covered box shows
   a solid green **online** (`index.get.ts:12`, `status.get.ts:9`).
2. **The screenshot command shows the player regardless.**
   `NativeFSBridge.screenshot()` does `webView.draw(canvas)` on a software canvas
   (`NativeFSBridge.kt:124`) — it renders the WebView's own view tree, not the
   display. The native flavor's `captureScreenshot()` draws the player root the
   same way. An operator checking "is TV #12 fine?" gets a perfect picture of the
   playlist while the screen shows something else entirely.

There is also a failure mode that the kiosk cannot self-heal and nobody can
currently see: **a dialog on top**. A system-update prompt, the OTA install
prompt, or any overlay does not trigger `onStop`/`onUserLeaveHint`, so the
snap-back watchdog never fires (`KioskActivity.kt:38,45`) and the player sits
behind the dialog indefinitely.

With `KioskLock.locked` true (the default) a real app switch self-corrects in
~400 ms, so ordinary exposure is brief. The cases that matter are: an unlock left
on, an app that relaunches itself in a loop (a snap-back war), and the dialog
case above.

## Decisions (locked during brainstorming)

1. **Live state plus counters. No episode-history table.** The dashboard answers
   "is TV #12 showing content right now?" and "is something fighting the kiosk on
   that box?". Per-episode forensics ("what covered it at 14:30 yesterday") is
   explicitly deferred — it needs a retention story, and `device_errors` has no
   pruning job to copy from.
2. **Report the intruder package, degrading to `null`.** `UsageStatsManager` is
   the only viable source on modern Android; it needs `GET_USAGE_STATS`, granted
   per box over ADB alongside the two appops already in the recipe at
   `android/README.md:142`. Ungranted boxes report `null` and the UI says
   "covered by unknown app".
3. **A 30 s heartbeat on the existing telemetry endpoint, plus an immediate post
   on every state change.** Not a new WS message type, not query params bolted
   onto the cached manifest GET. The heartbeat alone was not enough: state is only
   promoted inside `snapshot()`, so a 10 s occlusion falling entirely between two
   heartbeats would never be reported as a state at all — only as counter
   movement. The player therefore samples cheaply every 2 s and posts when the
   reportable state changes, on top of the 30 s floor. The heartbeat still gives
   the fleet its first genuine proof-of-life: telemetry is event-driven today
   (`usePlayerBoot.ts:70`), so a single looping video posts once per session.
   The stored `visibility` field is never latched — a recovered box must not keep
   showing as covered.
4. **Occlusion is a badge, never a status tier.** A covered box *is* online;
   collapsing the two facts into one pill would destroy information.
5. **The Android state machine is a pure core in `src/main`**, mirroring
   `KioskPin`: no Android imports, injected clock, JVM-unit-tested, inherited by
   both flavors from one implementation.
6. **State is debounced; counters are not.** The badge must not flicker on the
   ~400 ms snap-back blip, but a snap-back war is exactly what the counters exist
   to reveal.

## State model

Three independent lifecycle flags — `started`, `resumed`, `focused` — are fed by
four callbacks, and the state is derived from them:

| state | derived when | why that input |
|---|---|---|
| `background` | `!started` | `onStop`/`onStart` is the only signal that the Activity is fully hidden |
| `obscured` | started but `!resumed \|\| !focused` | an overlay pauses without stopping, and a dialog steals focus without pausing — either one means we are not the visible surface |
| `foreground` | started, resumed **and** focused | genuinely on screen |
| `unknown` | DB default only: a device that has never reported (pre-upgrade APK) | — |

Deriving `background` from `onStop` alone was wrong: an Activity stops being
resumed at `onPause`, which fires for a translucent or partial overlay that never
triggers `onStop`. Focus loss usually accompanies it, but "usually" is not a
contract — so `onPause` feeds the model directly.

**The initial state is `background`, not `foreground`.** All three flags start
false, so a process that is launched into the background (`BootReceiver`) never
claims to be on screen. This costs nothing when the player really is starting up
front: recovery to `foreground` is not debounced, so the first
`onStart`+`onResume`+focus flips it within milliseconds.

`unknown` is never sent by a client; it exists so the migration has a safe
default for existing rows.

A plain browser (no APK, no `NativeFS`) falls back to the Page Visibility API and
can therefore report only `foreground` / `background` — never `obscured`, since
`document.visibilityState` does not change when a dialog is drawn over the app.

**Counters**, all measured since process start:

- `snapBacks` — **departures** that armed a return, not calls to
  `scheduleKioskReturn`. That method runs twice for a single HOME press, from
  `onUserLeaveHint` and again from `onStop`; counting every call would double every
  figure. A `kioskReturnPending` flag makes it one increment per departure,
  cleared when the return runs or `onResume` cancels it. Counted **after** the
  `KioskLock.locked` check, so an unlocked box reports `0` while the operator
  walks away — leaving the screen deliberately is not the kiosk losing a fight.
- `focusLosses` — times `onWindowFocusChanged(false)` fired
- `hiddenMs` — cumulative milliseconds **not** in `foreground` (so `obscured`
  time counts toward it)

They are reported as absolute values and stored as reported. A value that goes
*down* means the app restarted — that is information, not a bug, and the UI
labels them "since app start". The server does not accumulate lifetime totals.

**Debounce is one-directional and scoped to the episode, not the sub-state.** A
non-`foreground` state is reported only once the *episode* — the unbroken stretch
of not being in `foreground` — has lasted **2 000 ms**, comfortably clear of the
400 ms `KIOSK_RETURN_MS` snap-back. The episode clock does **not** restart when
the state moves between `obscured` and `background`; without that, a focus loss
followed 1.9 s later by an `onStop` would hide a continuously-covered player for
nearly four seconds. Once the episode is past the debounce, the *current*
sub-state is what gets reported. A return to `foreground` is reported
immediately. Counters increment immediately in both directions, with no debounce.

**`hiddenMs` charges a single timestamp per operation and clamps negative
deltas**, so an NTP correction — routine on these boxes shortly after boot —
cannot drive the counter backwards.

`foregroundPackage` is `null` whenever the reported state is `foreground` — it
describes the intruder, so there is nothing to name when nobody is intruding.

## Wire contract

New **optional** fields on the existing telemetry body (flat, matching how
`apkVersion` and `surface` already ride along):

```ts
visibility?: 'foreground' | 'obscured' | 'background'
foregroundPackage?: string | null   // null when the appop isn't granted
snapBacks?: number                  // int >= 0
focusLosses?: number                // int >= 0
hiddenMs?: number                   // int >= 0
```

### The one breaking-ish change: `currentItemId` becomes optional

`handleTelemetry` increments `media.play_count` whenever `currentItemId !== null`
and there is no error (`telemetry.post.ts:44`). A 30 s heartbeat carrying the
current item would inflate every play count by 120×/hour.

So `currentItemId` moves from required-nullable to **optional**-nullable, and the
three cases become explicit:

| value | meaning | sender |
|---|---|---|
| absent (`undefined`) | don't touch the current item, don't count a play | heartbeat |
| `null` | clear the current item | `clearedCurrent` |
| number | a real play start — count it | `itemStarted` |

Every existing client always sends the field, so no deployed player changes
behavior. The heartbeat simply omits it.

`lastSeenAt` is stamped on every telemetry POST including heartbeats, so the
heartbeat also becomes a second, independent liveness source alongside the
manifest poll.

## Data model

Migration adds to `devices` (same shape as the earlier `surface` addition):

| column | type | default |
|---|---|---|
| `visibility` | text, not null | `'unknown'` |
| `visibility_since` | integer, timestamp_ms, nullable | — |
| `foreground_package` | text, nullable | — |
| `snap_backs` | integer, not null | `0` |
| `focus_losses` | integer, not null | `0` |
| `hidden_ms` | integer, not null | `0` |

`visibility_since` is computed **server-side**: stamped `now` only when the
incoming `visibility` differs from the stored value, left alone otherwise. That
makes "hidden for 4 minutes" derivable without the device tracking it.

## Android design

All new production code goes in `android/app/src/main/kotlin/ai/lanka/kiosk/`,
so `webview` and `native` inherit one implementation.

### New: `KioskVisibility.kt`

A pure core with zero Android imports and an injected clock
(`now: () -> Long = System::currentTimeMillis`), so it is JVM-unit-testable —
the same shape as `KioskPin`.

- `enum class State { FOREGROUND, OBSCURED, BACKGROUND }`
- `fun onStarted()`, `fun onResumed()`, `fun onPaused()`, `fun onStopped()`,
  `fun onFocusChanged(hasFocus: Boolean)`, `fun onSnapBackScheduled()`
- `fun snapshot(): Snapshot`, where `Snapshot` carries `state`, `snapBacks`,
  `focusLosses`, `hiddenMs`, plus two fields the transport needs:
  - `episodeMs` — how long the current non-`foreground` episode has lasted, which
    is what `ForegroundAppProbe` sizes its query window from;
  - `changeSeq` — incremented whenever the *reportable* state changes, so the
    sampling tick can post on a change without re-deriving one itself.
- `fun Snapshot.toJson(): String` — the bridge contract. It deliberately does
  **not** carry `foregroundPackage`: the package is a separate, more expensive
  bridge call made only when a post is actually going out.
- `companion object { fun shouldPost(seq, lastSeq, sinceLastPostMs): Boolean }` —
  the one-line transport rule (`seq != lastSeq || sinceLastPostMs >= 30_000`),
  kept in the pure core so it is unit-tested once. The TypeScript player mirrors
  it; there is no way to share the code across the two runtimes.

A single process-wide instance, like `KioskLock`, so a recreated Activity does not
reset the counters.

### New: `ForegroundAppProbe.kt`

`fun current(context, episodeMs): String?` — a wrapper over
`UsageStatsManager.queryEvents` returning the package that most recently moved to
the foreground, or `null`.

Two details that a naive version gets wrong:

- **The query window is derived from the episode, not fixed.** A fixed 10 s
  lookback is useless against a 30 s heartbeat: an app that took the screen 25 s
  ago has no event inside the window, so most sustained occlusions would report
  `null`. The window is `episodeMs` plus slack, floored at 30 s and capped at 6 h
  (a box hidden for days must not query an unbounded range).
- **The most recent resume wins, and if it is us, the answer is `null`.**
  Scanning for the latest *non-Lanka* event blames a stale, unrelated app when
  Lanka has since resumed, or when an own-app dialog stole focus without any
  other app resuming.

Every call is `runCatching`-guarded, so a ROM without the appop yields `null`
rather than throwing. Sampled **only** when the player is about to post a
non-`foreground` state — at most once per post, never on the playback hot path
and never on the 2 s sampling tick.

### Modified

- **`KioskActivity`** — feeds `KioskVisibility` from `onStart`, `onResume`,
  `onPause`, `onStop` and `onWindowFocusChanged` (which today handles only focus
  *regain*; the loss branch is what makes the dialog-on-top case visible for the
  first time). It also gains the `kioskReturnPending` flag so one departure counts
  as one snap-back.
- **`NativeFSBridge`** (webview) — two new methods, split by cost:
  `visibility(): String` returns the snapshot JSON with no UsageStats query, so
  the 2 s tick is nearly free; `foregroundPackage(episodeMs: Int): String`
  performs the probe and is called only when a post is going out. Both are gated
  by `privilegedOriginAllowed()` like the other data-returning methods, since the
  package name is mild exfil.
- **`PlayerActivity`** (native) — reads `KioskVisibility` directly, no bridge, on
  a daemon 2 s `scheduleWithFixedDelay` mirroring `ManifestClient.kt:149`.
- **`TelemetryClient`** (native) — takes a visibility supplier so **every** post
  is enriched, and gains `heartbeat(deviceId)`.
- **`android/README.md`** — a third line in the per-box recipe at line 142,
  **for both application IDs**, since the flavors install side by side:
  `adb shell appops set ai.lanka.kiosk GET_USAGE_STATS allow` and the same for
  `ai.lanka.kiosk.vs`. Granting only the base ID leaves the native APK reporting
  `null` forever.

## Server design

`handleTelemetry` (`server/api/devices/[id]/telemetry.post.ts`):

1. Extend `BodySchema` with the five optional fields; `foregroundPackage` capped
   at 128 chars.
2. `currentItemId` becomes optional — the play-count branch runs only when the
   field is present and non-null, exactly as today.
3. Compare incoming `visibility` to the stored value; on a change, set
   `visibility_since = now`.
4. Persist the counters as reported, using the same conditional-spread style
   already used for `apkVersion`/`surface`.
5. **Couple `foreground_package` to `visibility`.** Whenever `visibility` is
   present, the package column is written unconditionally: `null` for
   `foreground`, and otherwise whatever was reported (`null` included). Treating
   the two fields as independently optional would leave a previous intruder's
   name stored, ready to be shown again during a later episode whose probe
   returned nothing.

`status.get.ts` and `index.get.ts` return the new fields. Neither computes
occlusion state — that is the client's job; the server only stores and serves.

## Dashboard

- **Device list** — an amber chip on the row: "Not on screen", or "Covered by
  com.netflix.ninja" when the package is known.
- **Device detail** — the same chip next to the existing status pill, plus a
  "kiosk integrity" line showing the three counters with a "since app start"
  qualifier. Separately, while the device is online and not in `foreground`,
  "hidden for N" derived from `now − visibility_since` — the duration of the
  *current* episode, which is a different question from the cumulative
  `hidden_ms` and must not be conflated with it in the UI.
- **The chip renders only while the device is online.** Otherwise a box that died
  mid-occlusion would advertise "covered" forever, which is worse than silence.
- `obscured` gets its own wording — "Dialog on top" — because the operator
  response differs: an app switch is a kiosk-lock problem, a dialog is usually a
  system prompt that needs dismissing or an OTA that needs finishing.

## Web player

- **New `app/composables/player/useVisibility.ts`** — reads
  `NativeFS.visibility()` when the bridge is present, else falls back to the Page
  Visibility API (`document.visibilityState` + a `visibilitychange` listener),
  counting its own transitions so a browser still reports usable counters.
- **`useTelemetry`** — takes the visibility handle as a dependency and enriches
  **every** post from one place, so `itemStarted`, `itemFailed` and
  `clearedCurrent` all carry visibility without each call site having to pass it.
  It also gains `heartbeat(deviceId)`, which posts without `currentItemId`. The
  existing fire-and-forget, swallow-errors contract is unchanged: the player must
  keep playing even when telemetry is unreachable.
- **`usePlayerBoot`** — creates the visibility handle **before** the first
  reconcile, so the very first play start is already enriched, and runs a 2 s
  sampling tick that posts on state change or every 30 s. Because `boot()` is
  async and `onBeforeUnmount` is registered synchronously, a `disposed` flag is
  checked before any resource is created — otherwise an unmount during an await
  leaves the newly-created timer running.

## Testing

**Vitest:**

- A heartbeat (no `currentItemId`) does **not** increment `media.play_count` and
  does not clear `devices.current_item_id`.
- `currentItemId: null` still clears; a number still counts. Regression cover for
  the optionality change.
- `visibility_since` moves only on a real state change, not on every heartbeat.
- `status.get` and `index.get` expose the new fields.
- `useVisibility` prefers the bridge and falls back to Page Visibility.
- Every telemetry post — not just the heartbeat — carries visibility once the
  handle is injected.
- `visibility: 'foreground'` clears a previously stored `foreground_package`.

**JVM (`android/app/src/test/`, the shared source set — a shared class's test must
NOT live in `src/testNative/`, which compiles only into the native flavor):**

- `KioskVisibilityTest`: starts `BACKGROUND`; `onStart`+`onResume`+focus →
  `FOREGROUND` with no debounce; focus loss → `OBSCURED`; `onPause` alone →
  `OBSCURED`; `onStop` → `BACKGROUND`; a sub-2 s excursion never surfaces in
  `snapshot()` while still incrementing the counter; an `OBSCURED`→`BACKGROUND`
  move mid-episode does **not** restart the debounce; `hiddenMs` accumulates
  across both non-foreground states and never decreases when the clock goes
  backwards; `changeSeq` moves only on a reportable change; `shouldPost`.

Both flavors must build and test green: `./gradlew test` in `android/`.

## Out of scope

Deliberately excluded, and each would be its own piece of work:

- **Episode-history table** — needs a retention/pruning story.
- **Alerting** — no notification infrastructure exists in Lanka today.
- **Real screen capture** — `MediaProjection` needs a per-session consent dialog
  that device-owner cannot auto-grant. The counters answer the question better
  than a screenshot would.
- **Device-owner gating** — on a properly provisioned box lock-task means nothing
  can cover the player anyway; this feature is aimed at the un-provisioned fleet.
- **Acting on the signal** (auto-unlock, auto-reboot, dismissing dialogs). Report
  first; decide what to automate once there is field data.

## Risks

- **`hiddenMs` drift.** The counter is wall-clock based and keeps accruing while
  the box sleeps, so a TV that is off overnight reports a large `hiddenMs`. The
  UI must present it as "since app start", not as a fault, and the display should
  lead with the counters that are unambiguous (`snapBacks`, `focusLosses`).
- **`UsageStatsManager` returns nothing on some ROMs** even with the appop set.
  The design already degrades to `null`; the dashboard must never render an empty
  package name as a real answer.
- **The heartbeat adds one POST per device per 30 s** — ~1.7 req/s at 50 TVs,
  negligible against the existing manifest poll at the same cadence. Change-driven
  posts add to that only when boxes are actually being disturbed.
- **A sub-2 s excursion is still invisible as a state, by design.** It shows up
  only in `snapBacks`/`focusLosses`. That is the intended trade: the badge exists
  to report sustained occlusion, and the counters exist to report churn.
