# Lanka "Signal Room" Redesign — Design Spec

**Date:** 2026-06-07
**Scope:** Login + full dashboard. Both light and dark themes first-class.
**Direction:** "Operational calm" — a restrained signal-room control plane.
**Excluded:** The `/player` kiosk route and its components (`player/*`) — those are
TV-facing fullscreen screens, not dashboard UI, and stay as-is.

## Concept

Lanka is a broadcast/signage control plane (the radio-tower mark is the brand
seed). The identity is a calm **signal room**: status is the hero, the accent
never shouts. This deliberately replaces the current generic soft-lavender-on-white
wash with an intentional, professional system.

## Foundation — design tokens (both themes)

- **Accent:** a single confident **indigo** (`app.config` `ui.colors.primary: 'indigo'`),
  reserved for active nav, primary actions, focus rings, key data. Neutral stays `slate`.
- **Status colors reserved for meaning:** emerald = online, amber = warning,
  rose = offline, slate = idle/unclaimed. Never used decoratively.
- **Surfaces:** crisp cards — `rounded-2xl`, hairline border, soft shadow. Less
  glass/blur than today (more "operational").
  - *Light:* cool near-white canvas (slate-50) + faint indigo dot-grid texture + one soft corner glow.
  - *Dark:* deep ink canvas (slate-950) + elevated slate-900 cards.
- **Typography:** Bricolage Grotesque (display / big metric numbers) + Hanken
  Grotesque (UI) + **JetBrains Mono** (device IDs, pairing codes, timestamps).
- **Reusable utilities** in `main.css`: `.app-bg` (themed canvas + texture),
  `.soft-card` (themed card), `.reveal` (staggered page-load), `.hover-lift`.
  All `prefers-reduced-motion`-safe.

## Login — "broadcast panel" split

Two-column screen replacing the small centered card:
- **Left (dark gradient panel):** deep indigo→violet→ink gradient, slow concentric-ring
  signal pulse from the tower mark, grain overlay, Lanka wordmark + tagline, quiet
  footer ("Self-hosted · Tailscale-secured"). Same panel in both themes.
- **Right (form):** generous spacing, Bricolage "Sign in," larger refined fields,
  styled error state, full-width indigo button with arrow, staggered field reveal.
- Desktop-targeted (app is locked to 1280px min-width); degrades gracefully narrower.

## App shell (`layouts/default.vue`, `layouts/portal.vue`)

- **Solid left rail** (not transparent): refined wordmark + tiny live status dot;
  nav **grouped** into Manage / Content / Org with small section labels;
  **indigo-tinted active state** (replaces the heavy solid-black pill).
- **Footer = system-status block:** SSE connection chip + user identity + theme
  toggle + sign out. Theme toggle becomes functional (real dark theme).
- Portal layout: same identity, simplified single-column client shell.

## Components — cohesive pass

Aligned to the card + hairline + status-color system, both themes verified:
StatCard, Donut, StatusDot, EmptyState, ConfirmDialog, ErrorFeed,
UnclaimedDevicesTray, MediaCard, MediaPicker, MediaUploadDialog, AssignmentPicker,
PlaylistItemRow, and the device/media/playlist/address/group/organization
list + detail pages. Subtle hover lifts on cards/rows; mono for IDs.

## Motion

CSS-only, `prefers-reduced-motion`-safe: one orchestrated page-load reveal per
view, gentle card/row hover lifts, the login signal pulse.

## Non-goals

- No `/player` kiosk changes.
- No backend/API/store logic changes (auth flow, data fetching unchanged).
- No new dependencies (fonts via existing `@nuxt/fonts`).
