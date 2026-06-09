# Lanka — Ukrainian UI (i18n) Design

**Date:** 2026-06-09
**Status:** Approved (pre-implementation)
**Topic:** Translate the dashboard UI to Ukrainian via `@nuxtjs/i18n`

## Goal

Render the Lanka admin dashboard, auth pages, and client portal in Ukrainian by
default, using a proper i18n setup so English survives as a source-of-truth and a
language switcher can be added later in minutes.

## Decisions (locked)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Approach | `@nuxtjs/i18n` module | Keeps English available; future-proof; standard Nuxt tooling |
| Default locale | `uk` | App is for Ukrainian users |
| Switcher UI | None (yet) | YAGNI; `en.json` kept populated so a toggle is a few minutes later |
| URL strategy | `no_prefix` | Leaves all routes unchanged → auth-guard path checks & redirects untouched |
| Translations | Claude writes, user reviews | Fastest; user proofreads terminology |
| Scope | Admin dashboard + Auth pages + Client portal | The user-facing surfaces |
| Out of scope | Player screens, server/API messages, seed emails, brand/tokens | Minimal text / edge cases / not UI |

## Architecture

### 1. Module & configuration

Add `@nuxtjs/i18n` to `dependencies` and to the `modules` array in `nuxt.config.ts`:

```ts
i18n: {
  strategy: 'no_prefix',          // no /uk/ /en/ URL prefixes — routes & auth-guard paths unchanged
  defaultLocale: 'uk',
  fallbackLocale: 'en',           // any un-extracted string falls back to English, never a raw key
  detectBrowserLanguage: false,   // always Ukrainian, ignore browser
  locales: [
    { code: 'uk', name: 'Українська', file: 'uk.json' },
    { code: 'en', name: 'English',    file: 'en.json' }
  ]
}
```

- `strategy: 'no_prefix'` is deliberate: URLs are unchanged, so the Nitro
  `server/services/auth-guard.ts` path checks (`/api/...`, `/portal/...`) and the
  client `app/middleware/auth.global.ts` redirects keep working without edits.
- Locale JSON lives in `i18n/locales/uk.json` and `i18n/locales/en.json` (the
  module's default `restructureDir: 'i18n'`, resolved at repo root).
- `fallbackLocale: 'en'` guarantees a missed string shows English rather than a
  raw key like `devices.title`.

**`srcDir: '.'` gotcha (from CLAUDE.md):** because `srcDir` is `.`, Nuxt-scanned
directories default to repo root and have silently failed to load before
(`app/middleware/auth.global.ts`). The i18n `restructureDir` resolves at root,
which should be correct, but this is a known trap — **verify the locale files
actually load** (dev boots + a real key renders, no missing-key warning) before
mass-extracting strings. Do not assume.

### 2. Nuxt UI built-in component strings

`app/app.vue` already wraps the app in `<UApp>`. Nuxt UI ships a Ukrainian locale
(`@nuxt/ui/dist/runtime/locale/uk.js`). Wire it:

```vue
<script setup lang="ts">
import { uk } from '@nuxt/ui/locale'
</script>
<template>
  <UApp :locale="uk">
    ...
  </UApp>
</template>
```

This translates built-in widget text (pagination, table-empty, calendar, etc.)
with no manual strings.

### 3. String extraction & key namespacing

~126 strings are visible by a rough grep; the realistic total is ~200–300 once
toasts (`toast.add({ title, description })`), `aria-label`s, computed labels, and
multi-word template text nodes are included.

Keys are namespaced by surface so they stay findable:

```
common         Save / Cancel / Delete / Create / Edit / Confirm / Loading …
nav            sidebar + header labels
auth           login, forgot-password, reset-password
devices        app/pages/devices/*
addresses      app/pages/addresses/*
groups         app/pages/groups/*
playlists      app/pages/playlists/*
media          app/pages/media.vue
users          app/pages/users/index.vue
organizations  app/pages/organizations/index.vue
portal         app/pages/portal/*
components      ConfirmDialog, EmptyState, MediaUpload, AssignmentPicker, PageHeader …
errors         client-side validation strings
```

**Usage patterns:**
- Templates: `{{ $t('devices.title') }}`
- `<script setup>` (toasts, computed labels): `const { t } = useI18n()` → `t('...')`
- Interpolation: `$t('users.deleteConfirm', { email })` → `"Видалити {email}?"`
- Pluralization (Vue I18n plural syntax) where counts appear, e.g. `"{n} пристрій | {n} пристрої | {n} пристроїв"`

`en.json` is kept fully populated as the English source-of-truth mirror so
re-enabling English is just changing `defaultLocale`.

### 4. Out of scope (stays English)

- Player route + screens: `app/pages/player.vue`,
  `app/components/player/{StandbyScreen,NoContentScreen,PlayerStage}.vue`
- All server/Nitro API responses & validation messages (toasts surfacing
  `e?.data?.message` stay English)
- Seed emails, the "Lanka" brand name, technical tokens/ids

## Verification

- `pnpm build` passes — the real gate (per CLAUDE.md, typecheck is not a gate).
- `pnpm test` stays green. Tests call `handleXxx` server functions directly via
  `tests/helpers/nuxt-stubs.ts`; none mount Vue components or load the i18n
  module, so they are unaffected. (Confirmed: no `mount`/`mountSuspended` usage in
  `tests/`.)
- Manual dev pass (`PORT=5100 pnpm dev`): click through dashboard, auth, and
  portal; confirm Ukrainian renders with **no missing-key console warnings**.

## Risks

| Risk | Mitigation |
|------|-----------|
| `srcDir: '.'` causes i18n files to silently not load | Verify load before extraction (boot + render a key) |
| Missed string leaks a raw key | `fallbackLocale: 'en'` shows English instead |
| Ukrainian ~10–15% longer than English → layout wrap | Glance at buttons/table headers in dev; Nuxt UI mostly handles it |
| i18n module breaks the test env | Tests don't load nuxt.config/app runtime; verify `pnpm test` after install |

## Implementation order

1. Install `@nuxtjs/i18n` + configure + create empty/seeded locale files + set
   `<UApp :locale="uk">`. **Verify dev boots Ukrainian-ready and a key renders.**
2. Extract + translate file-by-file (dashboard pages → shared components → auth →
   portal), mirroring every key into `en.json`.
3. Verify each surface in dev; run `pnpm build` + `pnpm test`.
