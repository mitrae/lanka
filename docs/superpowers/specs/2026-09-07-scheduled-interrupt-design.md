# Scheduled interrupt — design

**Date:** 2026-09-07
**Status:** implemented
**Scope:** one fleet-wide daily clip that interrupts every playlist at a fixed
local time and hands the screen back where it left off.

## Purpose

Ukraine observes a nationwide minute of silence at 09:00. Every Lanka screen
must show a designated clip at that moment, whatever playlist it is running,
and then continue.

This is a compliance-shaped requirement, not a content-scheduling one, and the
design follows from that: a silently skipped observance is the failure mode
worth spending engineering on. Concretely that means the trigger must survive a
wrong TV clock, a dead SSE socket, a failed 09:00 poll and a cold boot at
09:00:35 — and when it does fail, an operator must be able to see which screen
failed, the same morning.

## Decisions taken during design

| Question | Decision |
|---|---|
| Late fires | **Join in progress.** At 09:00:35 the box starts 35 s into the clip and still ends at 09:01:00. Every screen stays frame-aligned with every other screen. |
| Audio | **None.** The clip is silent like all other media. The no-audio invariant (`-an` in every preset, `isKioskSafe` rejecting any audio stream) is not re-opened; a second decoder is what killed playback on the Haier TV. |
| Generality | **One fleet-wide daily interrupt.** No targeting, no multiple schedules. A second use case later is an honest migration. |
| Resume granularity | **Frame-exact**, obtained for free. The requirement was item-level; pausing the front element rather than tearing it down beats it at the same cost. |
| Surfaces | **Both**, WebView and native. Native has now been exercised on a real TV. |
| Devices with no playlist | **Do not observe.** `204` semantics are unchanged; the dashboard warns instead. |

## Architecture

Three layers, each ignorant of the next.

**The server decides *when*.** It publishes the next occurrence as an absolute
epoch in the device manifest. No timezone arithmetic, DST rule or calendar
logic ever runs on a TV.

**The player decides *whether it is time*.** A pure timer compares a
server-corrected clock against that epoch. It holds today's window from its
08:59 poll, so it fires with the network down.

**The stage stands down.** An overlay layer above the existing A/B slots plays
the clip while the playlist scheduler is suspended, then hands back. The
playlist state machine never learns that any of this happened.

### Why an overlay rather than a scheduler mode

`createPlayerScheduler` is a pure state machine over indices into
`manifest.items`. The interrupt clip has no such index, so teaching the
scheduler about it would mean a sentinel case in `getFrontIndex`,
`onItemStart`, the error budget and telemetry's `currentItemId` — and would put
a time-of-day concern inside the one component whose value is having none.

The overlay also buys the resume behaviour outright. A paused `<video>` keeps
its `currentTime` **and its decoder**; resuming is a `play()` call, with no
seek and no re-prime. Re-priming a decoder mid-clip is the documented cause of
the Haier failure, so the design that avoids it entirely is worth preferring
even before its simplicity is counted.

### Decoder budget

Normal playback holds two live video decoders: the visible front slot and the
`preload="auto"` back slot. During the interrupt the back slot is **emptied**
(`setItemInSlot(back, null)`, which genuinely releases the element) before the
overlay is given a source. Two decoders in, two decoders out. On Amlogic
hardware, where the instance limit is small and its symptom is a silent
failure to decode, this constraint is not negotiable and is the reason the
`arming` handshake below exists.

## Data model

New table `interrupts`, holding a single row (`id = 1`) enforced by the
service rather than by the schema:

| column | type | note |
|---|---|---|
| `id` | integer pk | always `1` |
| `media_id` | integer, FK → `media.id` | the clip |
| `at_minutes` | integer | minutes since local midnight; `540` = 09:00 |
| `timezone` | text | `Europe/Kyiv`, stored explicitly, never inferred |
| `enabled` | boolean | |
| `label` | text | e.g. "Хвилина мовчання"; shown in the dashboard |
| `updated_at` | integer | |

**Duration is deliberately not stored.** The window length comes from
`media.duration_ms`, so it can never disagree with the bytes actually on the
box.

One new column on `devices`: `last_interrupt_at` (integer, nullable) — the
`startsAt` the device last reported observing. See *Telemetry* below.

### Media deletion

`handleDeleteMedia force=true` runs a synchronous transaction that would
otherwise delete the clip out from under a configured observance, leaving a
schedule that silently never plays. So:

- deleting the interrupt's media returns **409** by default;
- `?force=true` **deletes the `interrupts` row in the same transaction**,
  rather than merely disabling it — a config whose `media_id` no longer
  resolves is not a valid disabled schedule, and `handleGetInterrupt` already
  treats a missing clip as "no config".

This is done explicitly in the handler, not via `ON DELETE`. Migration 0002
already demonstrated that a declared FK action in `schema.ts` need not exist in
the database.

## Server

### `server/services/interrupt.ts`

```
getInterrupt(db)            → row | null
putInterrupt(db, patch)     → row
nextWindow(nowMs, atMinutes, tz, durationMs) → { startsAt, endsAt } | null
```

`nextWindow` is pure and is the whole of the time logic. It returns **today's**
occurrence while `now < endsAt` — which is what makes joining in progress work
— and tomorrow's thereafter. Timezone and DST resolve here against Node's
tzdata via `Intl`. Ukraine's DST rules have been legislatively unsettled;
resolving them server-side means a package update fixes the fleet instead of
fifty Android ROMs.

### Manifest

`GET /api/devices/:id/manifest` gains two additive, optional fields:

```jsonc
"serverNow": 1789020000123,
"interrupt": {
  "mediaId": 42,
  "sha256": "…",
  "durationMs": 60000,
  "startsAt": 1789030800000,
  "endsAt": 1789030860000
}
```

Old bundles ignore them; the native parser already runs
`Json { ignoreUnknownKeys = true }` and the Kotlin fields get null defaults.

`serverNow` is the clock-offset source. It is refreshed every 30 s by the
existing poll, so a TV that boots with a wrong system clock still fires at the
right moment.

`204` is unchanged: a device with no assigned playlist receives no manifest and
therefore does not observe. The dashboard surfaces this as a warning.

### `GET` / `PUT /api/interrupt`

Admin and super only. A `PUT` emits the existing SSE `manifest-changed` kick so
boxes pick up a change without waiting out the poll. Validation: `at_minutes`
in range, media must exist and be a video.

## Web player

### Placement

The overlay is a sibling of the screen switch in `app/pages/player.vue`, not a
child of `PlayerStage`. It therefore also covers the standby and error screens,
and no manifest change can remount it mid-observance.

### New units

- **`createInterruptTimer`** — pure, no DOM, in the style of
  `createStallWatchdog`. Holds the schedule and the clock offset; answers
  `observe(now)` → `idle | active(offsetMs)`. It owns the edge cases: refuse to
  fire when the join offset already exceeds the clip duration; latch per
  `startsAt` so a backwards clock jump cannot replay the minute; clear the
  latch when a new `startsAt` arrives.
- **`InterruptOverlay.vue`** — one fullscreen muted `<video>` on black, given a
  source and a start offset.
- **A state machine in `usePlayerBoot`** — `idle → arming → playing → idle`.

### The `arming` handshake

Load-bearing, and the reason for a distinct state. Before the overlay is given
a source, `PlayerStage` must stand down **and acknowledge it**, because that is
when the back slot is released. Overlapping a third decoder with two live ones,
even briefly, is the fastest route to Amlogic's instance limit.

On `arming`, `PlayerStage`:

1. `scheduler.pause()`
2. pauses the front video
3. `setItemInSlot(backSlot(), null)`
4. **stops stall-watchdog sampling**
5. flips an acknowledgement ref, which advances the machine to `playing`

Step 4 is not optional. `createStallWatchdog` deliberately does not exempt
`paused` — a paused front video is itself a fault it exists to recover from —
so without the gate the observance triggers a full page reload about eight
seconds in. The failure would look like success on a casual watch, while
actually restarting the playlist.

On the way back down: restore the back-slot preload, `play()` the front (which
resumes at its exact `currentTime`), `resetProgressTracking()`,
`scheduler.resume()`.

### Scheduler changes

`createPlayerScheduler` gains only `pause()` / `resume()`: pause the image
timer capturing its remaining ms, re-arm with that remainder on resume. Modes,
`advancesOnError`, the single-item rules and the error budget are untouched.

### The overlay ends on the wall clock

At `endsAt` the overlay is torn down and the playlist resumes, **regardless of
what the video is doing**; `ended` also ends it early. This single rule makes
every overlay failure self-limiting: a hung, stalled or unreadable clip can
never hold a venue's screen for more than the window.

### Failure is loud, never blank

If the overlay errors, or has not decoded a frame within ~5 s, the interrupt is
abandoned immediately: the playlist resumes and a `device_errors` row is
written with the sha. `PlayerStage`'s existing `playViaBlob` rejected-cache
fallback is extracted to `app/composables/player/playViaBlob.ts` and shared,
rather than copied.

### Caching

The interrupt's sha joins the pre-download set and the `evictExcept` keep-list
in `useReconciler`, on the every-fetch channel below — so it is on disk long
before 09:00 and cannot be evicted by a playlist change.

### The reconciler's second channel

`shouldReconcile` compares only `playlistId:version`, so on an unchanged
playlist `reconcile()` returns early and emits nothing. The interrupt needs a
fresh `startsAt` and clock offset every 30 s while emphatically **not**
remounting the stage — a remount would restart the playing video.

So `createReconciler` gains a separate emit channel carrying
`{ serverNow, interrupt }`, fired on every successful fetch. Manifest-diff
semantics are unchanged.

### Telemetry

`currentItemId` is a `playlist_items.id`, which the interrupt has none of, so
it is left untouched for the duration — the existing heartbeat contract
("absent means don't touch the current item, don't count a play") already
covers this. The clip does not touch `media.play_count`.

One new optional field, **`interruptAt`**, is posted when the overlay genuinely
starts playing, and stored as `devices.last_interrupt_at`. Given that a silent
skip is the failure this feature exists to prevent, this is the point of the
feature rather than an extra: it is how an operator knows at 09:05 that 49 of
50 screens observed, and which one did not.

## Native surface

A mirror of the web work, following the porting pattern `StallWatchdog` set.

- **`player/InterruptTimer.kt`** — a 1:1 port of `createInterruptTimer`,
  JVM-tested against the same table as its TypeScript twin. Identical test
  tables are what keep the two from drifting.
- **`Manifest.kt`** — `serverNow: Long? = null`,
  `interrupt: ManifestInterrupt? = null`.
- **`ManifestClient` / `NativeSurface`** — the same split as on web:
  `ManifestDiffer` still gates the stage remount on `playlistId:version`, while
  the interrupt and clock offset arrive on a separate every-fetch callback. The
  pre-download loop and eviction keep-list gain the interrupt's sha.
- **`Scheduler.kt`** — `pause()` / `resume()` (Kotlin reserves `suspend` as a
  modifier keyword, so both surfaces name this the same way instead).
- **`NativeSurface` / `PlaybackView.kt`** — built as: `NativeSurface` owns its
  own overlay `ExoPlayer`, created on demand at the window and released after,
  rather than reattaching `PlaybackView`'s back player as first proposed here.
  `PlaybackView` gains `standDown()`/`standUp()`, mirroring the web stage's
  choreography (pause the scheduler, pause — never re-prepare — the front
  player, empty the back slot, stop watchdog sampling; reverse on the way
  back up). Two reasons for the separate overlay player over a reattachment:
  the decoder budget comes out identical either way (the back slot is still
  emptied, so it's front-paused + overlay = 2), and this version also covers
  the standby / no-content screens — states where no `PlaybackView` exists on
  screen at all, which the web overlay covers by construction (it lives in
  `player.vue`, a sibling of the stage, not inside `PlayerStage.vue`).
  Watchdog sampling stops for the window; the wall-clock end rule is identical
  to web.
- **`TelemetryClient`** — carries `interruptAt`.

Native's image path has no network fallback; for the interrupt, an uncached
clip falls back to the http(s) URL so the box observes rather than showing
black.

Ownership rule applies as everywhere else: whatever the interrupt path creates,
it releases — the overlay view, the reattachment, the sampling tick.

## Dashboard

A new nav entry, **Schedule** (`/schedule`, `i-lucide-alarm-clock`), admin and
super only. One page, two halves.

**Configuration** — enabled toggle, a media picker restricted to videos, an
`HH:MM` time input, a free-text label, and the timezone shown read-only as
`Europe/Kyiv`. The selected clip's real duration is displayed beside the time,
since that, not a stored number, defines the window.

**Observance status** — the half that makes a silent skip impossible. Per
device, today's outcome derived from `last_interrupt_at` against today's
`startsAt`: observed at 09:00:01, missed, or offline. Plus the warning that
devices with no assigned playlist receive a `204` and will not observe.

The media page gets a badge on the interrupt's clip, backed by the 409 above.

All new strings land in both `en.json` and `uk.json`. `tests/i18n/plurals.test.ts`
enforces the parity, and the `uk` plural-order trap applies to any count string
on the status list.

## Testing

**Vitest**

- `nextWindow` — today's occurrence while `now < endsAt`; rollover after; the
  exact `endsAt` boundary; both Europe/Kyiv DST transitions (09:00 local stays
  09:00 local across each); disabled → null.
- `createInterruptTimer` — fires at `startsAt`; computes the join offset;
  refuses when the offset exceeds the duration; latches per `startsAt`; clears
  the latch on a new `startsAt`; applies the `serverNow` offset.
- `createPlayerScheduler` — pause halts the image timer; resume re-arms with
  the **remaining** time, not a fresh full duration; pause/resume idempotent;
  `stop()` while paused.
- `useReconciler` — the interrupt is emitted on every successful fetch while
  the manifest is **not** re-emitted on an unchanged key; the interrupt sha
  reaches both the download set and the `evictExcept` keep-list.
- API — manifest field shape and absence when disabled; `/api/interrupt` auth
  (401/403 for `client`) and validation; media deletion 409 and the
  `force=true` delete inside the transaction.

**Gradle** — `InterruptTimerTest.kt` against the same table as the TS test;
scheduler pause/resume.

**On-box checklist.** Where the real risk lives, and what no test reaches. Run
against a production build (`pnpm build` + `node .output/server/index.mjs`,
never `pnpm dev`), with the interrupt set two minutes ahead:

1. Multi-item playlist with a video playing: it pauses, and afterwards resumes
   **at the same second**, not from zero.
2. Single-video playlist — the freeze-prone mode — same result.
3. Image playlist: the slide does not advance during the minute and honours its
   remaining time afterwards.
4. **No page reload during the minute** (the watchdog gate). Its failure looks
   like success unless watched for.
5. `device_errors` clean; `last_interrupt_at` within a second or two of
   09:00:00.
6. Late join: start the box mid-window; it enters at the right offset and still
   ends on time.
7. Network pulled before the window: it fires anyway, from the schedule it
   already holds, off the local cache.
8. Both surfaces.

## Rollout

Two independent steps.

**WebView** is server-side only: deploy, and boxes take the new bundle through
the existing `playerBuild` mismatch reload. No APK.

**Native** needs a release: bump `android/version.properties`, build with
`scripts/build-apk.sh` so it picks up the fleet keystore and
`LANKA_KIOSK_PIN` (verify `BuildConfig.KIOSK_PIN_LENGTH == 4`), then OTA.

Sequence: server + web to the test box, verify against the checklist, prod
deploy, then the APK for native.

The migration is additive and runs from `scripts/entrypoint.sh`.

**Docs:** `CLAUDE.md` gains an interrupt section, and its "still unverified on
real hardware" note about the native surface is corrected — native has now been
exercised on a TV.

## Out of scope

- Multiple schedules, days-of-week rules, and per-address/group/device
  targeting. One fleet-wide daily interrupt only.
- Audio.
- Observance on devices with no assigned playlist.
