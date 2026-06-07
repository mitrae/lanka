# Lanka — Auth, Organizations & Light Redesign

- **Date:** 2026-06-07
- **Status:** Approved (brainstorm complete)
- **Author:** dmytro + Claude
- **Spec type:** Feature design (new auth subsystem + new entity + visual redesign)

## 1. Context & problem

Lanka today has **no authentication** — the dashboard, the full management API, and
the device-facing endpoints are all wide open behind the Tailscale tailnet. The schema
has `addresses`, `groups`, `devices`, `media`, `playlist_items`, `assignments`,
`device_errors` — and no users, sessions, or roles.

We want to:

1. Add a **login** and a **user/role system** (`super`, `admin`, `client`).
2. Let **clients** (advertisers) log in and view **read-only stats** for the media they own.
3. Re-skin the dashboard into a **light, modern "soft-card" theme** inspired by the
   SugarCRM "Customer Journeys" reference (pale lavender→white gradient, large rounded
   white/frosted cards, black active states, soft blue + coral data accents, donut charts).

### Why an Organization entity (not Address-scoped clients)

A physical **Address** can show a playlist that mixes media from *several different
clients*. So content ownership cannot live at the address. It lives on the **media**:
each creative belongs to an advertiser. A **client** user is linked to an
**Organization** (company/advertiser) and sees aggregated reach for *all media their org
owns*, across every screen showing it.

## 2. Goals / non-goals

**Goals**
- Username + password login with server-side sessions.
- Three roles with a clear permission boundary.
- A new `organizations` entity; `media` optionally owned by an org.
- A read-only **client portal** showing reach/distribution stats for an org's media.
- Light "soft-card" theme foundation applied to login, the shared shell, Overview, and the portal.
- **Never lock the Android TVs out** of their device endpoints.

**Non-goals (this round)**
- Playback-impression counting (requires APK changes + a `playback_events` table) — schema
  is left open for it, but it is **not** built now.
- Re-skinning the other five management pages (Round 2).
- Per-device token authentication (future hardening).
- SSO / OAuth / email-magic-link.

## 3. Locked decisions

| Question | Decision |
|---|---|
| Scope of this round | **Phase it.** Round 1 = auth + roles + portal + theme foundation. Round 2 = re-skin remaining pages. |
| Auth mechanism | **Username + password, server sessions.** |
| Client data model | **New `organizations` entity**; `media.organizationId`; clients linked to an org. |
| Client stats meaning | **Reach now** (from existing assignment data, no player change); impressions later. |
| Navigation layout | **Keep the left sidebar, restyle it** into the light soft-card look. |
| Password hashing | **Node `crypto.scrypt`** — zero new native dependencies. |

## 4. Data model

New migration (`pnpm db:generate` from schema changes):

```text
organizations
  id            integer PK autoincrement
  name          text NOT NULL
  createdAt     timestamp_ms
  updatedAt     timestamp_ms

users
  id              integer PK autoincrement
  username        text NOT NULL UNIQUE
  passwordHash    text NOT NULL           -- scrypt: "scrypt$N$r$p$salt$hash" (self-describing)
  role            text NOT NULL CHECK role IN ('super','admin','client')
  organizationId  integer NULL → organizations.id ON DELETE CASCADE
  createdAt       timestamp_ms
  updatedAt       timestamp_ms
  CHECK ( (role = 'client' AND organizationId IS NOT NULL)
       OR (role IN ('super','admin') AND organizationId IS NULL) )

sessions
  id            text PK                  -- sha256(rawCookieToken); cookie holds the raw token
  userId        integer NOT NULL → users.id ON DELETE CASCADE
  expiresAt     timestamp_ms NOT NULL
  createdAt     timestamp_ms

media   (alter)
  + organizationId  integer NULL → organizations.id ON DELETE SET NULL
    -- null = unowned "house" content
```

Drizzle relations added: `users.organization`, `organizations.users`,
`organizations.media`, `media.organization`.

## 5. Authentication architecture

### Password hashing
Node built-in `crypto.scrypt` (async). Store a **self-describing** string
`scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>` so params can evolve. Constant-time compare via
`crypto.timingSafeEqual`. No new dependency.

### Sessions
- On login: generate a random token (`crypto.randomBytes(32)` → base64url). Store
  `sha256(token)` as the session `id`; set cookie value = raw token. A DB leak therefore
  never exposes a live session.
- Cookie: `httpOnly`, `sameSite=lax`, `path=/`, `maxAge` = session TTL (e.g. 30 days).
  **`secure` is off** — traffic runs as http over the WireGuard-encrypted tailnet, where a
  `secure` cookie would never be sent. (Revisit if TLS is ever terminated in front.)
- Expiry checked on every request; expired/absent → no `event.context.user`.
- Logout deletes the session row and clears the cookie.

### Middleware & route classification
`server/middleware/auth.ts` reads the cookie, looks up a non-expired session, attaches
`event.context.user = { id, role, organizationId }` (or leaves it undefined). It does **not**
itself reject — a small helper `requireRole(event, roles)` (used by handlers / a thin
per-tier guard) does enforcement, so the public tier stays trivially open.

| Tier | Routes | Rule |
|---|---|---|
| **Public** (unchanged behavior) | `/api/healthz`, `/api/auth/**`, `/media/**`, `/api/devices/register`, `/api/devices/:id/manifest`, `/api/devices/:id/stream`, `/api/devices/:id/telemetry` | no auth |
| **Dashboard** | addresses/groups/playlists/assignments/media CRUD; `/api/devices` (list/get/patch/delete); `/api/devices/:id/reload`; `/api/dashboard/stream`; organizations & users mgmt | `admin` or `super` |
| **Client portal** | `/api/portal/**` | `client` (own org only) |

> **Safety-critical:** the device-facing endpoints (`register`, `manifest`, `stream`,
> `telemetry`) and `/media/**` stay password-free in this round. Verified device callers:
> `register.post.ts`, `[id]/manifest.get.ts`, `[id]/stream.get.ts`, `[id]/telemetry.post.ts`.
> `[id]/reload.post.ts` is dashboard-initiated (emits a reload over the events hub) → guarded.
> A test asserts every device endpoint remains reachable without a session.

### Auth endpoints
- `POST /api/auth/login` `{ username, password }` → sets session cookie, returns `{ user }`.
  Rate-limit-friendly generic error on bad creds (no user-enumeration).
- `POST /api/auth/logout` → clears session.
- `GET /api/auth/me` → `{ user }` or 401. Drives the SPA's client-side guard.

## 6. Login, routing & roles

- **`/login`** — new page in the new light theme (centered card on the gradient bg, or a
  split brand/form layout). Posts to `/api/auth/login`.
- **Client-side guard** — Nuxt route middleware checks an `useAuth()` store (hydrated from
  `/api/auth/me`); unauthenticated → redirect to `/login`. This is UX only; the server APIs
  are the real enforcement (SPA, `ssr:false`).
- **Post-login landing:** `super`/`admin` → `/` (Overview, full sidebar). `client` → `/portal`.
- **Layout:** management routes use the restyled `default` layout (sidebar). The client
  portal uses a **minimal layout** (brand + "My stats" + logout; no management sidebar).

### Permission matrix

| Capability | super | admin | client |
|---|---|---|---|
| Manage addresses/groups/devices/media/playlists/assignments | ✓ | ✓ | — |
| Manage organizations | ✓ | ✓ | — |
| Create/manage **client** users | ✓ | ✓ | — |
| Create/manage **admin/super** users | ✓ | — | — |
| View reach stats (own org) | — | — | ✓ |
| View **any** org's reach stats (admin UI) | Round 2 | Round 2 | — |

The `/api/portal/**` tier is **client-only** in Round 1 (a client only ever sees its own
org). An admin-facing "view any org's stats" surface is deferred to Round 2 (see §11).

### Seeding (first run, idempotent)
On startup (or via the migrate/entrypoint step), if no users exist, create:
- `super`, `admin` users (no org),
- one demo **organization** + a `client` user linked to it,
- assign a few existing media rows to the demo org (so the portal shows real data).

Passwords come from env (`SEED_SUPER_PASSWORD`, `SEED_ADMIN_PASSWORD`,
`SEED_CLIENT_PASSWORD`); if unset, a strong random password is generated **and printed to
the server log once**. No hardcoded default credentials. Seeding is a no-op if the users
already exist.

## 7. Client portal — reach stats (no player changes)

`GET /api/portal/stats` (client-auth; scoped to `event.context.user.organizationId`):

For each media owned by the org, computed by **reusing the existing assignment-resolution
logic** (`playlist_items → playlists → assignments → devices`, honoring the
Address→Group→Device most-specific-wins rule):
- screens where it is scheduled (distinct devices, with their addresses/groups),
- screens **showing it right now** (`devices.current_item_id` → item → media),
- online / offline counts (online = `last_seen_at` within 5 min),
- recent playback errors (`device_errors.sha256` ↔ `media.sha256`).

Plus an **org rollup**: media count, total distinct screens reached, screens online,
currently-playing count.

Optionally `GET /api/portal/media/:id` for per-media drill-down (same scoping check).

The response shape leaves room for a future `playback_events` table to add impression
counts without breaking the contract.

## 8. Visual redesign — light "soft-card" theme (Round 1 surfaces)

Work **with** Nuxt UI v3 theming (`app.config.ts` colors + Tailwind `@theme` in
`app/assets/css/main.css`); keep the dark/light toggle but flip the **default to light**.

- **Fonts (drop Inter):** **Bricolage Grotesque** for big bold display/titles +
  **Hanken Grotesque** for body/UI (excellent tabular numerals for a stats dashboard),
  loaded via `@nuxt/fonts`. Mono stays JetBrains Mono for device IDs.
- **Palette (light default):**
  - Background: soft **periwinkle→white gradient** with a faint lavender wash.
  - Surfaces: white / frosted-white cards, hairline borders, soft shadows, large radii (rounded-2xl/3xl).
  - **Black** primary actions & the active sidebar item (the reference's signature move).
  - **Soft blue + coral** data accents (status pills, donut arcs); soft green for "online".
  - Slate neutrals; near-black headings; muted-slate secondary text.
  - Nuxt UI: `neutral: slate`; primary tuned for focus/links; black rendered via the neutral
    solid variant / explicit classes for active + CTA.
- **Components (Round 1):**
  - Restyle the shared sidebar shell (`app/layouts/default.vue`): light surfaces, black
    active pill, soft hover, connection dot.
  - Rebuild Overview stat cards in the soft-card style + an inline-**SVG donut** for
    online/offline (no chart dependency).
  - Pastel rounded-full status pills.
  - One orchestrated **staggered card-reveal** on load (CSS `animation-delay`); subtle hover lift.
  - New `/login` and `/portal` pages built natively in the new theme.

## 9. Phasing

**Round 1 (this build)**
- Schema migration: `organizations`, `users`, `sessions`, `media.organizationId`.
- Auth backend: scrypt hashing, sessions, `auth` middleware + `requireRole`, login/logout/me.
- Route classification enforced; device endpoints proven open by test.
- Idempotent seed (super/admin/client + demo org + media assignment).
- `useAuth` store + client-side route guard + role-based landing.
- Organizations: minimal admin **list/create** page + a **media→org assignment** control,
  so the client portal has real data.
- Client portal page + `/api/portal/stats` (reach).
- Light theme foundation applied to: `/login`, the sidebar shell, Overview, the portal.

**Round 2 (follow-up)**
- Re-skin Addresses, Groups, Devices, Media, Playlists to the new aesthetic.
- Richer organization management (edit/delete, member management, bulk media assignment).
- (Later) playback impressions: `playback_events` table + APK reporting + time-series charts.

## 10. Testing (vitest, `pool: 'forks'`)

- `scrypt` hash → verify round-trip; wrong password rejected; timing-safe compare.
- Session: create → validate → expire (no `user` after `expiresAt`); logout deletes row.
- `requireRole`: allow/deny matrix per role; client scoped to own org; cross-org access denied.
- **Route classification test**: every device endpoint + `/media/**` + `/api/healthz`
  reachable with no session; a dashboard endpoint returns 401 with no session and 403 for a client.
- Reach-stats aggregation: known fixture → expected screen/online/now-playing counts;
  respects most-specific assignment resolution; only the org's own media included.
- Seed idempotency: running twice creates no duplicates; respects existing users.
- Update `tests/helpers/nuxt-stubs.ts` for any new Nitro auto-imports (e.g. `setCookie`,
  `getCookie`, `deleteCookie`).

## 11. Open questions / future work

- Per-device token auth (replace the public device tier) — future hardening.
- Password reset / change-password UI (Round 2+).
- Playback impressions (the big follow-up that makes "stats" richer).
- Whether `admin` should be able to view arbitrary org stats in the admin UI now or Round 2.
