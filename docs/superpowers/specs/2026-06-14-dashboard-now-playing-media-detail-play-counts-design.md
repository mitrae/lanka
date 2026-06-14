# Dashboard: device now-playing, media detail/edit, and play counts

**Date:** 2026-06-14
**Status:** Approved (design)

## Goal

Three small dashboard additions, validated against the live Tanix box:

1. **Device "now playing"** — on the device detail page, show what a device is currently displaying, with online/offline, refreshed in near-real-time.
2. **Media detail/edit drawer** — view a media item's metadata + usage and assign it to an organization.
3. **Play counts (count-only)** — count each play of a media item and surface the running total to admins (media drawer) and to the owning client (portal). **No billing / no time-buckets** — those are a future spec.

## Non-goals (deferred)

- Billing, cost calculation, per-period (daily/monthly) aggregation, invoices.
- Play-event audit log / per-device play history.
- Any player/APK change (counting reuses existing telemetry).

## Data model

One new column:

- `media.play_count` — `integer NOT NULL DEFAULT 0`. Running total of plays. New Drizzle migration (`pnpm db:generate` → `pnpm db:migrate`).

## Play counting

In `server/api/devices/[id]/telemetry.post.ts` `handleTelemetry`:

- The player already POSTs `{ currentItemId }` once per item **start** (fire-and-forget, event-driven — see `useTelemetry`/`createPlayerScheduler`). Failures POST `{ currentItemId, error }`; clears POST `{ currentItemId: null }`.
- **Counting rule:** when `currentItemId !== null` **and** `body.error` is absent (a real start, not a failure or clear), resolve the playlist item → its `mediaId` and `play_count += 1`.
- This increments once per loop of a looping playlist — correct for "number of plays".

## API changes

- **`GET /api/devices/:id/status`** (new, dashboard-auth): returns
  `{ online: boolean, lastSeenAt, currentItem: { mediaId, filename, kind, sha256 } | null, playlistName: string | null }`.
  `online` = `lastSeenAt` within **90s** (manifest poll is 30s). Resolves `current_item_id` → playlist item → media + playlist.
- **`GET /api/media` (list)** — add `organizationId` and `playCount` to each row (currently omitted in the select).
- **`GET /api/media/:id`** — enrich with: the playlists it appears in (id + name), `organizationId`, `playCount`.
- **Organizations** — reuse the existing organizations list endpoint (used by the orgs page) to populate the assignment dropdown.
- **Portal stats** — add `playCount` per media to the existing `OrgReach.media[]` payload (the portal stats endpoint behind `api.getPortalStats()`).

## UI

- **Device now-playing** (`app/pages/devices/[id].vue`): a "Now playing" card — thumbnail + filename + kind + playlist name, plus an online/offline badge and last-seen. Polls `GET /api/devices/:id/status` every **5s**; stops on unmount.
- **Media detail drawer** (`app/pages/media.vue` + new `MediaDetailDrawer` component): clicking a `MediaCard` opens a slide-over (Nuxt UI `USlideover`) showing:
  - **File metadata:** size (human-readable), dimensions, duration, type/mime, uploaded date, sha256.
  - **Usage:** playlists it appears in (names) + count.
  - **Organization:** dropdown to set/clear the owner → `PUT /api/media/:id/organization` (admin/super only).
  - **Play count:** running total, polled every **5s** while the drawer is open so it visibly ticks up.
- **Portal** (`app/pages/portal/index.vue`): add a **"Plays"** column to the existing media table (and an optional total-plays `StatCard`). The page polls so the client sees counts rise (small delay acceptable).

## i18n

All new visible strings go through `$t(...)` with Ukrainian + English entries, matching the existing dashboard i18n.

## Testing

- **Vitest (handlers):**
  - Counting rule: a start (`currentItemId` set, no error) increments the right media's `play_count`; a failure (`error` present) and a clear (`currentItemId: null`) do **not**.
  - `GET /api/devices/:id/status`: online threshold, current-item resolution, null when nothing playing.
  - Media list/detail include `organizationId` + `playCount`; org assignment updates the field.
- **Manual (live box):** play the assigned video on the Tanix box; confirm `play_count` rises in the media drawer and the portal table within a few seconds.

## Rollout / scope

3 features · 1 migration · 4 small API edits · 3 UI touches. Forward-compatible with a future billing spec (which would add a play-event log / period aggregation on top of the same org ownership + telemetry signal).
