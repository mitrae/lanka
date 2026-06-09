# Ukrainian UI (i18n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Lanka admin dashboard, auth pages, and client portal in Ukrainian by default via `@nuxtjs/i18n`, keeping English as a populated source-of-truth.

**Architecture:** Add the `@nuxtjs/i18n` module with `strategy: 'no_prefix'` and `defaultLocale: 'uk'` (so URLs and auth-guard path checks are untouched), extract every UI string into namespaced `i18n/locales/{uk,en}.json`, replace inline text with `$t()` / `useI18n().t()`, and set the Nuxt UI component locale to Ukrainian via `<UApp :locale="uk">`. `fallbackLocale: 'en'` means a missed key shows English, never a raw key.

**Tech Stack:** Nuxt 4 (SPA, `ssr: false`), `@nuxtjs/i18n`, Vue I18n (Composition mode), Nuxt UI v4, pnpm, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-ukrainian-ui-i18n-design.md`

---

## Scope

**In scope (translate):** admin dashboard pages (`app/pages/{index,devices,addresses,groups,playlists,media,users,organizations}`), auth pages (`login`, `forgot-password`, `reset-password`), client portal (`app/pages/portal/*`), and all shared components those surfaces use (`app/components/*`, excluding `app/components/player/*`).

**Out of scope (stays English):** `app/pages/player.vue` + `app/components/player/*`, all server/Nitro API & validation messages, seed emails, the brand name "Lanka", and technical tokens/ids.

---

## File structure

**Created:**
- `i18n/i18n.config.ts` — Vue I18n core options (Composition mode, `fallbackLocale: 'en'`).
- `i18n/locales/uk.json` — Ukrainian messages (the default users see).
- `i18n/locales/en.json` — English mirror (source-of-truth; same key set as `uk.json`).

**Modified:**
- `nuxt.config.ts` — add `@nuxtjs/i18n` to `modules` + an `i18n: { … }` config block.
- `app/app.vue` — set `<UApp :locale="uk">`.
- `package.json` — `@nuxtjs/i18n` dependency (added by `pnpm add`).
- Every in-scope `.vue` file under `app/pages/` and `app/components/` — inline English text replaced with translation calls.

---

## Conventions (apply in every task)

### Key namespacing
JSON is namespaced by surface so keys stay findable:

```
common         shared verbs/nouns: Save / Cancel / Delete / Create / Edit / Close / Loading / Confirm / Back …
nav            sidebar group labels + items + footer (Realtime, Sign out, theme toggle)
auth           login, forgot-password, reset-password
devices        app/pages/devices/*
addresses      app/pages/addresses/*
groups         app/pages/groups/*
playlists      app/pages/playlists/*
media          app/pages/media.vue
users          app/pages/users/index.vue
organizations  app/pages/organizations/index.vue
portal         app/pages/portal/*
overview       app/pages/index.vue
components      ConfirmDialog, EmptyState, PageHeader, StatCard, MediaUploadDialog, MediaPicker, AssignmentPicker, PlaylistItemRow, UnclaimedDevicesTray, ErrorFeed, StatusDot, Donut, MediaCard …
errors         client-side validation / catch-block toast titles
```

Reuse `common.*` for generic verbs before inventing a surface-specific key. **`en.json` and `uk.json` must always have the identical key set** — add to both in the same step.

### Usage patterns
- **Template text node:** `<h1>Devices</h1>` → `<h1>{{ $t('devices.title') }}</h1>`
- **Template attribute:** `placeholder="Select…"` → `:placeholder="$t('common.selectPlaceholder')"`, `aria-label="Sign out"` → `:aria-label="$t('nav.signOut')"`
- **`<script setup>` (toasts, computed labels):** add `const { t } = useI18n()` at top of the setup block, then `t('users.createFailed')`. `useI18n` is auto-imported by the module — no manual import.
- **Interpolation:** `` `Delete ${u.email}?` `` → `t('users.deleteConfirm', { email: u.email })` with `"deleteConfirm": "Видалити {email}?"`
- **Pluralization (Vue I18n pipe syntax):** counts like "3 devices" → `t('devices.count', n, { n })` with `"count": "{n} пристрій | {n} пристрої | {n} пристроїв"` (Ukrainian needs 3 plural forms).

### Hard constraint — keep `useI18n` out of stores/services
Pinia stores (`app/stores/*`) and any file imported by `tests/` must **not** call `useI18n()` — tests don't load the i18n module and would crash. Translation lives only in `.vue` pages/components. If a store currently builds a user-facing string, leave it; translate at the component that renders it.

### Per-surface extraction procedure (the repeatable loop)
For each in-scope file:
1. Read the file; list every user-visible English string (text nodes, `label`/`placeholder`/`title`/`aria-label` attrs, `toast.add` titles+descriptions, `ConfirmDialog` titles/bodies, computed label strings). Skip: CSS classes, icon names (`i-lucide-*`), `name`/`type`/`autocomplete` attrs, URLs, the word "Lanka".
2. Add a key for each under the file's namespace in **both** `uk.json` (Ukrainian, per glossary) and `en.json` (verbatim English).
3. Replace each string in the file with `$t('…')` (template) or `t('…')` (script), adding `const { t } = useI18n()` to the setup block if the script needs it.
4. Verify (see "Verification commands" below): the surface renders Ukrainian in dev with **no `[intlify]`/missing-key warning** in the browser console.

### Verification commands
- Build gate (the real gate per CLAUDE.md): `pnpm build` → exits 0.
- Test gate: `pnpm test` → all green.
- Missing-key scan (static): after editing, no leftover obvious English in the file:
  `grep -nE '>[A-Z][a-zA-Z]{3,}|label="[A-Z]|placeholder="[A-Z]|aria-label="[A-Z]' <file>` → only allowed hits (e.g. "Lanka", dynamic `{{ }}`).
- Manual render: `PORT=5100 pnpm dev`, open the surface, confirm Ukrainian + a clean console.

---

## Terminology glossary (use consistently across all files)

| English | Ukrainian | Notes |
|---------|-----------|-------|
| Device | Пристрій | pl. Пристрої |
| Group | Група | pl. Групи |
| Address | Адреса | pl. Адреси |
| Playlist | Плейлист | pl. Плейлисти |
| Media | Медіа | invariant |
| User | Користувач | pl. Користувачі |
| Organization | Організація | pl. Організації |
| Overview | Огляд | dashboard home |
| Sign in | Увійти | login button |
| Sign out | Вийти | |
| Email | Електронна пошта | label; placeholders can stay literal address samples |
| Password | Пароль | |
| Forgot password? | Забули пароль? | |
| Save | Зберегти | |
| Cancel | Скасувати | |
| Delete | Видалити | |
| Create | Створити | |
| Edit | Редагувати | |
| Add | Додати | |
| Close | Закрити | |
| Confirm | Підтвердити | |
| Loading… | Завантаження… | |
| Upload | Завантажити | |
| Role | Роль | |
| Status | Статус | |
| Online / Offline | Онлайн / Офлайн | |
| Realtime | У реальному часі | sidebar status |
| Standby | Очікування | |
| Select… | Вибрати… | generic select placeholder |
| Search… | Пошук… | |
| Name | Назва | (Ім'я only for a person's name) |
| Settings | Налаштування | |
| This cannot be undone. | Цю дію не можна скасувати. | confirm bodies |

Extend the glossary as new domain terms appear; keep one Ukrainian term per English term across all files.

---

## Task 1: Install & configure `@nuxtjs/i18n` (with seeded locale files)

**Files:**
- Modify: `nuxt.config.ts`
- Modify: `package.json` (via `pnpm add`)
- Create: `i18n/i18n.config.ts`
- Create: `i18n/locales/uk.json`
- Create: `i18n/locales/en.json`

- [ ] **Step 1: Install the module**

Run:
```bash
pnpm add @nuxtjs/i18n
```
Expected: `@nuxtjs/i18n` appears under `dependencies` in `package.json`; install completes 0.

- [ ] **Step 2: Create the Vue I18n config file**

Create `i18n/i18n.config.ts`:
```ts
// Vue I18n core options. Module options (locales, strategy, defaultLocale) live
// in nuxt.config.ts; vue-i18n core options (legacy/fallback) must live here.
export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en'
}))
```

- [ ] **Step 3: Seed the locale files**

Create `i18n/locales/en.json`:
```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "create": "Create",
    "edit": "Edit",
    "add": "Add",
    "close": "Close",
    "confirm": "Confirm",
    "back": "Back",
    "loading": "Loading…",
    "selectPlaceholder": "Select…",
    "searchPlaceholder": "Search…",
    "cannotBeUndone": "This cannot be undone."
  },
  "nav": {
    "overview": "Overview",
    "network": "Network",
    "addresses": "Addresses",
    "groups": "Groups",
    "devices": "Devices",
    "content": "Content",
    "media": "Media",
    "playlists": "Playlists",
    "people": "People",
    "users": "Users",
    "organizations": "Organizations",
    "signageControl": "Signage control",
    "realtime": "Realtime",
    "signOut": "Sign out",
    "switchToDark": "Switch to dark mode",
    "switchToLight": "Switch to light mode"
  }
}
```

Create `i18n/locales/uk.json`:
```json
{
  "common": {
    "save": "Зберегти",
    "cancel": "Скасувати",
    "delete": "Видалити",
    "create": "Створити",
    "edit": "Редагувати",
    "add": "Додати",
    "close": "Закрити",
    "confirm": "Підтвердити",
    "back": "Назад",
    "loading": "Завантаження…",
    "selectPlaceholder": "Вибрати…",
    "searchPlaceholder": "Пошук…",
    "cannotBeUndone": "Цю дію не можна скасувати."
  },
  "nav": {
    "overview": "Огляд",
    "network": "Мережа",
    "addresses": "Адреси",
    "groups": "Групи",
    "devices": "Пристрої",
    "content": "Контент",
    "media": "Медіа",
    "playlists": "Плейлисти",
    "people": "Люди",
    "users": "Користувачі",
    "organizations": "Організації",
    "signageControl": "Керування екранами",
    "realtime": "У реальному часі",
    "signOut": "Вийти",
    "switchToDark": "Перейти в темний режим",
    "switchToLight": "Перейти в світлий режим"
  }
}
```

- [ ] **Step 4: Register & configure the module in `nuxt.config.ts`**

Change the `modules` array to include i18n:
```ts
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxtjs/color-mode', '@pinia/nuxt', '@nuxtjs/i18n'],
```

Add this `i18n` block as a top-level key in `defineNuxtConfig({ … })` (e.g. just after the `components` line):
```ts
  i18n: {
    strategy: 'no_prefix',          // leave every URL unchanged — auth-guard path checks rely on this
    defaultLocale: 'uk',
    detectBrowserLanguage: false,   // always Ukrainian, never sniff the browser
    vueI18n: 'i18n.config.ts',      // resolved inside the i18n/ restructure dir
    locales: [
      { code: 'uk', name: 'Українська', file: 'uk.json' },
      { code: 'en', name: 'English', file: 'en.json' }
    ]
  },
```

- [ ] **Step 5: Verify the build still passes**

Run: `pnpm build`
Expected: exits 0, no `Cannot resolve` / unknown-module errors. (If it errors that locale files aren't found, the `i18n/locales/` path is wrong for this version — fix `langDir`/file paths until it resolves. This is the `srcDir: '.'` trap from CLAUDE.md.)

- [ ] **Step 6: Commit**

```bash
git add nuxt.config.ts package.json pnpm-lock.yaml i18n/
git commit -m "feat(i18n): add @nuxtjs/i18n, default uk locale, seed common+nav strings"
```

---

## Task 2: Wire Nuxt UI locale + translate the shell (login + sidebar) — LOAD GATE

This task doubles as the **load-verification gate**: it proves keys actually resolve in the running SPA before mass extraction, and it's the fully-worked example for every later task.

**Files:**
- Modify: `app/app.vue`
- Modify: `app/layouts/default.vue`
- Modify: `app/pages/login.vue`
- Modify: `i18n/locales/uk.json`, `i18n/locales/en.json` (add `auth` namespace)

- [ ] **Step 1: Set the Nuxt UI component locale to Ukrainian**

In `app/app.vue`, add to the `<script setup>` block:
```ts
import { uk } from '@nuxt/ui/locale'
```
and change the template root from `<UApp>` to:
```vue
  <UApp :locale="uk">
```
(closing tag stays `</UApp>`.)

- [ ] **Step 2: Add the `auth` namespace to both locale files**

Append to `en.json` (top level):
```json
  "auth": {
    "signIn": "Sign in",
    "signInSubtitle": "Welcome back. Enter your credentials to reach the console.",
    "emailLabel": "Email",
    "passwordLabel": "Password",
    "forgotPassword": "Forgot password?",
    "invalidCredentials": "Invalid email or password",
    "googleFailed": "Google sign-in failed, or no Lanka account for that address",
    "or": "or",
    "heroHeading": "Your screens, one calm console.",
    "heroSubtitle": "Monitor, group, and program every display across your network — from one quiet control plane.",
    "trustFooter": "Self-hosted · Tailscale-secured",
    "provisionNote": "Lanka signage control plane · access is provisioned by your administrator."
  }
```

Append to `uk.json` (top level):
```json
  "auth": {
    "signIn": "Увійти",
    "signInSubtitle": "З поверненням. Введіть свої дані, щоб увійти до консолі.",
    "emailLabel": "Електронна пошта",
    "passwordLabel": "Пароль",
    "forgotPassword": "Забули пароль?",
    "invalidCredentials": "Невірна електронна пошта або пароль",
    "googleFailed": "Не вдалося ввійти через Google або для цієї адреси немає облікового запису Lanka",
    "or": "або",
    "heroHeading": "Ваші екрани — одна спокійна консоль.",
    "heroSubtitle": "Спостерігайте, групуйте та програмуйте кожен екран у вашій мережі — з однієї тихої панелі керування.",
    "trustFooter": "Власний хостинг · захищено Tailscale",
    "provisionNote": "Панель керування екранами Lanka · доступ надає ваш адміністратор."
  }
```

- [ ] **Step 3: Translate `app/pages/login.vue`**

Add `const { t } = useI18n()` to the `<script setup>` block (after the existing refs). Replace the two error strings:
```ts
    error.value = t('auth.invalidCredentials')
```
```ts
    error.value = t('auth.googleFailed')
```
In the template, replace (left → right):
- `Your screens,<br >one calm console.` → `{{ $t('auth.heroHeading') }}`
- the hero `<p>` paragraph text → `{{ $t('auth.heroSubtitle') }}`
- `<span>Self-hosted · Tailscale-secured</span>` → `<span>{{ $t('auth.trustFooter') }}</span>`
- `<h1 …>Sign in</h1>` → `<h1 …>{{ $t('auth.signIn') }}</h1>`
- the subtitle `<p>` "Welcome back…" → `{{ $t('auth.signInSubtitle') }}`
- `<UFormField label="Email">` → `<UFormField :label="$t('auth.emailLabel')">`
- `<UFormField label="Password">` → `<UFormField :label="$t('auth.passwordLabel')">`
- `<NuxtLink … >Forgot password?</NuxtLink>` → inner text `{{ $t('auth.forgotPassword') }}`
- `<span>or</span>` → `<span>{{ $t('auth.or') }}</span>`
- the `<UButton>` "Sign in" label → `{{ $t('auth.signIn') }}`
- the final `<p>` "Lanka signage control plane…" → `{{ $t('auth.provisionNote') }}`

Leave `placeholder="you@company.com"`, `placeholder="••••••••"`, and the literal "Lanka" brand spans as-is.

- [ ] **Step 4: Translate the sidebar in `app/layouts/default.vue`**

Replace the `navGroups` literal so labels come from i18n (the file already has `useI18n` available via auto-import — add `const { t } = useI18n()` to the setup block):
```ts
const navGroups = computed(() => [
  { items: [{ label: t('nav.overview'), icon: 'i-lucide-layout-dashboard', to: '/' }] },
  {
    label: t('nav.network'),
    items: [
      { label: t('nav.addresses'), icon: 'i-lucide-building-2', to: '/addresses' },
      { label: t('nav.groups'), icon: 'i-lucide-folder', to: '/groups' },
      { label: t('nav.devices'), icon: 'i-lucide-tv', to: '/devices' }
    ]
  },
  {
    label: t('nav.content'),
    items: [
      { label: t('nav.media'), icon: 'i-lucide-image', to: '/media' },
      { label: t('nav.playlists'), icon: 'i-lucide-list-music', to: '/playlists' }
    ]
  },
  {
    label: t('nav.people'),
    items: [
      { label: t('nav.users'), icon: 'i-lucide-users', to: '/users' },
      { label: t('nav.organizations'), icon: 'i-lucide-briefcase', to: '/organizations' }
    ]
  }
])
```
Update the template loop to use `.value` only if needed (computed unwraps in template, so `v-for="(group, gi) in navGroups"` still works). Replace remaining literals:
- `<p …>Signage control</p>` → `{{ $t('nav.signageControl') }}`
- `<span …>Realtime</span>` → `{{ $t('nav.realtime') }}`
- `:aria-label="`Switch to ${…} mode`"` → `:aria-label="colorMode.value === 'dark' ? $t('nav.switchToLight') : $t('nav.switchToDark')"`
- `aria-label="Sign out"` → `:aria-label="$t('nav.signOut')"`

Leave the `{{ streamState }}` value (technical state token) and `{{ auth.role }}` as-is for now.

- [ ] **Step 5: LOAD GATE — verify keys resolve in the running app**

Run: `PORT=5100 pnpm dev` (background), then open `http://localhost:5100/login` and `http://localhost:5100/` (log in with `super@lanka.live` / `lanka-dev`).
Expected:
- Login page shows "Увійти", "Електронна пошта", "Пароль", "Забули пароль?".
- Sidebar shows "Огляд / Мережа / Адреси / Групи / Пристрої / …".
- Browser console has **no `[intlify] Not found 'x.y' key`** warnings.
If keys render as raw `auth.signIn` text → the locale files didn't load (the `srcDir: '.'` trap); fix paths/`langDir` in `nuxt.config.ts` until they resolve. **Do not proceed to Task 3 until this gate passes.**

- [ ] **Step 6: Verify build + tests**

Run: `pnpm build` → exits 0.
Run: `pnpm test` → all green.

- [ ] **Step 7: Commit**

```bash
git add app/app.vue app/layouts/default.vue app/pages/login.vue i18n/
git commit -m "feat(i18n): Ukrainian Nuxt UI locale + translate login & sidebar shell"
```

---

## Task 3: Translate remaining auth pages

**Files:**
- Modify: `app/pages/forgot-password.vue`
- Modify: `app/pages/reset-password.vue`
- Modify: `i18n/locales/{uk,en}.json` (extend `auth` namespace)

- [ ] **Step 1: Extract & translate**

Apply the **Per-surface extraction procedure** to both files under the `auth` namespace (keys like `auth.forgotTitle`, `auth.forgotSubtitle`, `auth.sendResetLink`, `auth.resetTitle`, `auth.newPassword`, `auth.resetSuccess`, etc.). Translate per the glossary; add identical keys to `uk.json` and `en.json`. Use `const { t } = useI18n()` for any toast/error strings.

- [ ] **Step 2: Static scan**

Run: `grep -nE '>[A-Z][a-zA-Z]{3,}|label="[A-Z]|placeholder="[A-Z]' app/pages/forgot-password.vue app/pages/reset-password.vue`
Expected: only allowed hits (brand "Lanka", literal email sample placeholders).

- [ ] **Step 3: Manual render**

In dev, open `/forgot-password` and `/reset-password?token=test` — Ukrainian renders, console clean.

- [ ] **Step 4: Commit**

```bash
git add app/pages/forgot-password.vue app/pages/reset-password.vue i18n/
git commit -m "feat(i18n): translate forgot/reset-password pages"
```

---

## Task 4: Translate shared components

**Files:**
- Modify: `app/components/ConfirmDialog.vue`, `EmptyState.vue`, `PageHeader.vue`, `StatCard.vue`, `StatusDot.vue`, `ErrorFeed.vue`, `Donut.vue` (only ones with literal text)
- Modify: `i18n/locales/{uk,en}.json` (`components` + `common` namespaces)

- [ ] **Step 1: Extract & translate**

Apply the **Per-surface extraction procedure** to each component. Generic verbs (the `ConfirmDialog` confirm/cancel buttons) reuse `common.*`; component-specific copy goes under `components.*` (e.g. `components.emptyTitle`, `components.errorFeedTitle`). For components that take text via props (e.g. `ConfirmDialog` title/body passed by callers), **do not** hardcode — the caller passes already-translated strings; only translate text that's literal inside the component itself.

- [ ] **Step 2: Static scan**

Run: `grep -rnE '>[A-Z][a-zA-Z]{3,}|label="[A-Z]|placeholder="[A-Z]|aria-label="[A-Z]' app/components/ConfirmDialog.vue app/components/EmptyState.vue app/components/PageHeader.vue app/components/StatCard.vue app/components/StatusDot.vue app/components/ErrorFeed.vue app/components/Donut.vue`
Expected: only allowed hits.

- [ ] **Step 3: Build**

Run: `pnpm build` → exits 0.

- [ ] **Step 4: Commit**

```bash
git add app/components/ i18n/
git commit -m "feat(i18n): translate shared dashboard components"
```

---

## Task 5: Translate media & assignment components

**Files:**
- Modify: `app/components/MediaCard.vue`, `MediaPicker.vue`, `MediaUploadDialog.vue`, `AssignmentPicker.vue`, `PlaylistItemRow.vue`, `UnclaimedDevicesTray.vue`
- Modify: `i18n/locales/{uk,en}.json` (`components` namespace; pluralized counts where present)

- [ ] **Step 1: Extract & translate**

Apply the **Per-surface extraction procedure** to each file. Watch for: upload progress/empty states, drag-drop hints, "N items"/"N selected" counts (use the pipe pluralization pattern from Conventions), and `aria-label`s. Add `const { t } = useI18n()` where scripts build strings.

- [ ] **Step 2: Static scan**

Run: `grep -rnE '>[A-Z][a-zA-Z]{3,}|label="[A-Z]|placeholder="[A-Z]|aria-label="[A-Z]' app/components/MediaCard.vue app/components/MediaPicker.vue app/components/MediaUploadDialog.vue app/components/AssignmentPicker.vue app/components/PlaylistItemRow.vue app/components/UnclaimedDevicesTray.vue`
Expected: only allowed hits.

- [ ] **Step 3: Manual render**

In dev, open `/media` and a playlist editor; exercise the upload dialog & assignment picker — Ukrainian renders, console clean.

- [ ] **Step 4: Commit**

```bash
git add app/components/ i18n/
git commit -m "feat(i18n): translate media & assignment components"
```

---

## Task 6: Translate devices pages

**Files:**
- Modify: `app/pages/devices/index.vue`, `app/pages/devices/[id].vue`
- Modify: `i18n/locales/{uk,en}.json` (`devices` namespace)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** under the `devices` namespace; static-scan both files; render `/devices` and a device detail page in dev (console clean); then:
```bash
git add app/pages/devices/ i18n/
git commit -m "feat(i18n): translate devices pages"
```

---

## Task 7: Translate addresses pages

**Files:**
- Modify: `app/pages/addresses/index.vue`, `app/pages/addresses/[id].vue`
- Modify: `i18n/locales/{uk,en}.json` (`addresses` namespace)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** under the `addresses` namespace; static-scan; render `/addresses` + a detail page (console clean); then:
```bash
git add app/pages/addresses/ i18n/
git commit -m "feat(i18n): translate addresses pages"
```

---

## Task 8: Translate groups pages

**Files:**
- Modify: `app/pages/groups/index.vue`, `app/pages/groups/[id].vue`
- Modify: `i18n/locales/{uk,en}.json` (`groups` namespace)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** under the `groups` namespace; static-scan; render `/groups` + a detail page (console clean); then:
```bash
git add app/pages/groups/ i18n/
git commit -m "feat(i18n): translate groups pages"
```

---

## Task 9: Translate playlists pages

**Files:**
- Modify: `app/pages/playlists/index.vue`, `app/pages/playlists/[id].vue`
- Check (no `useI18n` here — it's a `.ts` logic helper imported by tests): `app/components/PlaylistEditor.logic.ts` — if it produces user-facing strings, leave them; translate at the consuming `.vue`.
- Modify: `i18n/locales/{uk,en}.json` (`playlists` namespace)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** under the `playlists` namespace; confirm no `useI18n` was added to `PlaylistEditor.logic.ts`; static-scan the `.vue` files; render `/playlists` + the editor (console clean); then:
```bash
git add app/pages/playlists/ i18n/
git commit -m "feat(i18n): translate playlists pages"
```

---

## Task 10: Translate the media page

**Files:**
- Modify: `app/pages/media.vue`
- Modify: `i18n/locales/{uk,en}.json` (`media` namespace)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** under the `media` namespace; static-scan; render `/media` (console clean); then:
```bash
git add app/pages/media.vue i18n/
git commit -m "feat(i18n): translate media page"
```

---

## Task 11: Translate users & organizations pages

**Files:**
- Modify: `app/pages/users/index.vue`, `app/pages/organizations/index.vue`
- Modify: `i18n/locales/{uk,en}.json` (`users`, `organizations` namespaces)

- [ ] **Step 1: Extract & translate**

Apply the **Per-surface extraction procedure**. Known strings in `users/index.vue` to cover: `'Pick an organization for the client'`, `'Could not create user'`, `` `Delete ${u.email}?` ``, `'Their sessions end immediately. This cannot be undone.'`, `'Could not delete user'`, `'Password copied'`, `'Copy failed'`, `'Select and copy the password manually.'`, labels `Email`/`Role`/`Organization`, placeholders, and the `:aria-label="`Delete ${u.email}`"`. Use interpolation for the `${u.email}` cases, e.g.:
```json
"users": { "deleteConfirm": "Видалити {email}?", "deleteAria": "Видалити {email}" }
```
```ts
const { t } = useI18n()
// …
title: t('users.deleteConfirm', { email: u.email })
```
Reuse `common.cannotBeUndone` inside the delete-confirm body.

- [ ] **Step 2: Static scan**

Run: `grep -rnE ">[A-Z][a-zA-Z]{3,}|title: '[A-Z]|description: '[A-Z]|label=\"[A-Z]|placeholder=\"[A-Z]|aria-label" app/pages/users/index.vue app/pages/organizations/index.vue`
Expected: only allowed hits / dynamic bindings.

- [ ] **Step 3: Manual render**

In dev, open `/users` and `/organizations`; trigger create + delete flows; confirm Ukrainian toasts/dialogs and a clean console.

- [ ] **Step 4: Commit**

```bash
git add app/pages/users/ app/pages/organizations/ i18n/
git commit -m "feat(i18n): translate users & organizations pages"
```

---

## Task 12: Translate the client portal

**Files:**
- Modify: `app/layouts/portal.vue`, `app/pages/portal/index.vue`
- Modify: `i18n/locales/{uk,en}.json` (`portal` namespace; reuse `nav.signOut` etc.)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** to the portal layout + page under the `portal` namespace; static-scan; render `/portal` while logged in as `client@lanka.live` / `lanka-dev` (console clean); then:
```bash
git add app/layouts/portal.vue app/pages/portal/ i18n/
git commit -m "feat(i18n): translate client portal"
```

---

## Task 13: Translate the Overview (dashboard home)

**Files:**
- Modify: `app/pages/index.vue`
- Modify: `i18n/locales/{uk,en}.json` (`overview` namespace)

- [ ] **Step 1–4:** Apply the **Per-surface extraction procedure** under the `overview` namespace (stat-card titles, section headings, empty states, any `StatCard`/`Donut` labels passed as props). Static-scan; render `/` (console clean); then:
```bash
git add app/pages/index.vue i18n/
git commit -m "feat(i18n): translate overview dashboard"
```

---

## Task 14: Final verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Whole-app static residue scan**

Run:
```bash
grep -rnE '>[A-Z][a-zA-Z]{3,}<|label="[A-Z][a-zA-Z]|placeholder="[A-Z][a-zA-Z]|aria-label="[A-Z][a-zA-Z]|title: *['"'"'"][A-Z]' app/pages app/components app/layouts | grep -v 'app/components/player\|player.vue\|Lanka\|i-lucide'
```
Expected: empty (or only intentional English like brand/tech tokens). Investigate every remaining hit; translate or justify.

- [ ] **Step 2: Build gate**

Run: `pnpm build`
Expected: exits 0.

- [ ] **Step 3: Test gate**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Full manual sweep + missing-key check**

Run: `PORT=5100 pnpm dev`. Walk every in-scope surface (login → overview → addresses → groups → devices → media → playlists → users → organizations → portal). Confirm Ukrainian throughout and **zero `[intlify] Not found` warnings** in the console across all pages.

- [ ] **Step 5: Confirm key-set parity between locales**

Run:
```bash
node -e "const a=require('./i18n/locales/uk.json'),b=require('./i18n/locales/en.json');const flat=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'?flat(v,p+k+'.'):[p+k]);const ua=new Set(flat(a)),eb=new Set(flat(b));const miss=[...eb].filter(k=>!ua.has(k)),extra=[...ua].filter(k=>!eb.has(k));console.log('uk missing:',miss);console.log('uk extra:',extra)"
```
Expected: both arrays empty (identical key sets in `uk.json` and `en.json`).

- [ ] **Step 6: Final commit (if any residue was fixed)**

```bash
git add -A
git commit -m "chore(i18n): final residue cleanup + verify locale parity"
```

---

## Notes & risks (carried from spec)

- **`srcDir: '.'` trap:** locale files silently not loading is the #1 risk — the Task 2 LOAD GATE exists to catch it before bulk work. Don't skip it.
- **`fallbackLocale: 'en'`** guarantees a missed key shows English, never a raw `device.title`.
- **Stores/services stay i18n-free** so the Vitest suite (which never loads the module) keeps passing.
- **Ukrainian ~10–15% longer** than English — eyeball buttons/table headers during each manual render; Nuxt UI handles most wrapping.
- **Player & server messages stay English** by design.
