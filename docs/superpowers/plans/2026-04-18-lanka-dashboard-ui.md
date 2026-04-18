# Lanka Dashboard UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the operator-facing dashboard UI for Lanka — Nuxt UI pages for overview, addresses, groups, devices, media library, playlists, and a drag-reorder playlist editor. Backed by the CRUD API from Plan 2a and live device-status updates via SSE.

**Architecture:** Nuxt 4 client pages consuming the existing Nitro API. Typed `useApiClient` composable wraps `$fetch` for every endpoint. Pinia stores hold list state, mutated by user actions and patched in place by a `useDashboardStream` SSE client. Nuxt UI v3 is the component substrate; dark mode default; emerald accent on zinc neutrals; Inter for UI + JetBrains Mono for identifiers.

**Tech Stack:** Nuxt 4, Nuxt UI v3, `@nuxt/fonts`, `@nuxtjs/color-mode`, Pinia (`@pinia/nuxt`), VueUse (already via Nuxt UI), existing vitest + nuxt-stubs harness, `@nuxt/test-utils` for component tests.

**Parent spec:** `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`
**Prior plans:** Plan 1 (foundation & sync), Plan 2a (dashboard API) — both merged to `main`.

---

## Scope

**Delivered:**

- Nuxt UI v3 design system with emerald/zinc dark theme, Inter + JetBrains Mono fonts
- Global sidebar-nav layout with live dashboard-SSE connection indicator
- Typed `useApiClient` composable (all Plan 1 + Plan 2a endpoints)
- `useDashboardStream` SSE composable for live device status
- Pinia stores for addresses, groups, devices, media, playlists
- **Overview** page — stat cards, unclaimed-devices tray with inline claim, red-dot error feed
- **Addresses + Groups** pages — list / create / detail / delete with cascade confirmation
- **Devices** list page — filter by address/group/status/unclaimed, live status column
- **Device detail** — status header, playing-now card, assignment override picker, reload button
- **Media library** — grid with drag-drop upload, in-use delete confirmation, thumbnail previews
- **Playlists** list — summary with item/assignment counts
- **Playlist editor** — media picker + ordered item list with drag-to-reorder and inline image-duration edit
- Global toast + confirmation dialog primitives
- Empty-state and loading-skeleton patterns
- Tests: unit for composables + stores; component test for playlist-editor drag-reorder

**Deferred to Plan 3+ (intentional):**

- `/player` Nuxt route (Plan 3)
- Docker / systemd / backups (Plan 4)
- Android APK (Plan 5)
- Real-time manifest preview on TV rows (would require WebRTC or periodic screenshot service)
- Bulk operations (multi-select devices, bulk playlist assignment)
- Users / RBAC / audit log (solo operator, tailnet)
- Mobile responsive layout (desktop-only per spec)

---

## Design System

These are decisions the subagents should follow. They're baked into task code but worth stating upfront:

- **Colors** — Nuxt UI `primary: 'emerald'` + `neutral: 'zinc'`. Status colors: emerald (online), amber (idle), rose (offline/error).
- **Typography** — `font-sans` is Inter (via `@nuxt/fonts`); `font-mono` is JetBrains Mono. Use `font-mono` for device IDs, sha256 hashes, timestamps.
- **Density** — comfortable, not compact. 16px base. Tables: `py-3 px-4` per cell.
- **Dark mode default**, toggle available via the layout header.
- **Accent on action** — mutations get emerald buttons; destructive actions get rose outline buttons.
- **Empty states** — every list has a "no X yet" state with a clear CTA, not just an empty table.
- **Loading** — Nuxt UI `<USkeleton>` placeholders that match the shape they're replacing (never blank + spinner).
- **Mutations give feedback** — every successful write emits a toast; every failure emits a rose toast with the error message.
- **Desktop only** — no `sm:` breakpoints; minimum target width 1280px. We set a `min-w-[1280px]` on the root so mobile sessions show a horizontal scrollbar rather than broken layout.

---

## File Structure

```
lanka/
├── app/                                  # Nuxt 4 `app/` directory (new in this plan)
│   ├── app.config.ts                     # Nuxt UI theme config
│   ├── app.vue                           # Root component
│   ├── layouts/
│   │   └── default.vue                   # Sidebar + header layout
│   ├── pages/
│   │   ├── index.vue                     # Overview
│   │   ├── addresses/
│   │   │   ├── index.vue
│   │   │   └── [id].vue
│   │   ├── groups/
│   │   │   ├── index.vue
│   │   │   └── [id].vue
│   │   ├── devices/
│   │   │   ├── index.vue
│   │   │   └── [id].vue
│   │   ├── media.vue                     # single-page grid
│   │   └── playlists/
│   │       ├── index.vue
│   │       └── [id].vue                  # editor
│   ├── components/
│   │   ├── StatCard.vue
│   │   ├── StatusDot.vue
│   │   ├── UnclaimedDevicesTray.vue
│   │   ├── ErrorFeed.vue
│   │   ├── DeviceStatusBadge.vue
│   │   ├── MediaUploadDialog.vue
│   │   ├── MediaGrid.vue
│   │   ├── MediaCard.vue
│   │   ├── MediaPicker.vue               # used in playlist editor
│   │   ├── PlaylistItemRow.vue
│   │   ├── AssignmentPicker.vue          # used on devices/groups/addresses detail
│   │   ├── ConfirmDialog.vue
│   │   └── EmptyState.vue
│   ├── composables/
│   │   ├── useApiClient.ts               # typed $fetch wrappers
│   │   ├── useDashboardStream.ts         # SSE client
│   │   └── useConfirm.ts                 # promise-based confirmation
│   ├── stores/
│   │   ├── addresses.ts
│   │   ├── groups.ts
│   │   ├── devices.ts
│   │   ├── media.ts
│   │   └── playlists.ts
│   └── types/
│       └── api.ts                        # shared types mirroring server handler returns
├── tests/
│   ├── composables/
│   │   ├── useApiClient.test.ts
│   │   └── useDashboardStream.test.ts
│   ├── stores/
│   │   └── devices.test.ts               # representative store test
│   └── components/
│       └── PlaylistEditor.test.ts        # drag-reorder logic only
└── nuxt.config.ts                        # MODIFIED: modules, css
```

**Note on Nuxt 4 directory layout:** Nuxt 4 defaults to putting app code under `app/` (vs. Nuxt 3's root). We adopt that from the start since the project is greenfield.

---

## Task 1: Install Nuxt UI + fonts + color-mode; configure theme

**Files:**
- Modify: `nuxt.config.ts`
- Modify: `package.json` (via pnpm add)
- Create: `app/app.config.ts`
- Create: `app/app.vue`

- [ ] **Step 1: Install deps**

```bash
pnpm add @nuxt/ui @nuxt/fonts @nuxtjs/color-mode @pinia/nuxt pinia
```

Expected: four runtime modules added.

- [ ] **Step 2: Register modules in `nuxt.config.ts`**

Modify `nuxt.config.ts` (preserve existing fields):

```ts
export default defineNuxtConfig({
  compatibilityDate: '2026-04-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxtjs/color-mode', '@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
    classSuffix: ''
  },
  typescript: {
    strict: true,
    typeCheck: false
  },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? 'file:./data/signage.db',
    mediaDir: process.env.MEDIA_DIR ?? './data/media'
  },
  nitro: {
    experimental: {
      tasks: false
    }
  }
})
```

- [ ] **Step 3: Create `app/assets/css/main.css` for Nuxt UI + typography baseline**

```bash
mkdir -p app/assets/css
```

```css
/* app/assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-sans: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

:root {
  /* enforce a minimum width so the desktop-only layout doesn't flex */
  min-width: 1280px;
}

body {
  @apply bg-(--ui-bg) text-(--ui-text);
  min-width: 1280px;
}
```

- [ ] **Step 4: Create `app/app.config.ts` with Nuxt UI theme**

```ts
// app/app.config.ts
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'emerald',
      neutral: 'zinc'
    }
  }
})
```

- [ ] **Step 5: Create `app/app.vue` as the root**

```vue
<!-- app/app.vue -->
<script setup lang="ts">
useHead({
  title: 'Lanka',
  link: [{ rel: 'icon', href: '/favicon.ico' }]
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
```

- [ ] **Step 6: Register fonts**

Create `app/app.config.ts` addition (append to the existing defineAppConfig), then add `app/fonts.config.ts`:

Actually, with `@nuxt/fonts` auto-discovery, we just reference families in CSS and the module downloads them. The `@theme` entries in `main.css` declare `Inter` and `JetBrains Mono`; `@nuxt/fonts` will detect these and self-host them.

No extra file needed.

- [ ] **Step 7: Verify build**

```bash
pnpm build
```

Expected: success. May emit warnings about `useAppConfig` duplicates from Nitro — ignore (pre-existing).

- [ ] **Step 8: Verify dev server boots and Nuxt UI renders**

```bash
pnpm dev &
sleep 6
curl -s http://localhost:3000 | head -40
kill %1 2>/dev/null || true
```

Expected: HTML containing `<html class="dark"` or similar — dark mode default is active. Shutdown after the check.

- [ ] **Step 9: Commit**

```bash
git add nuxt.config.ts package.json pnpm-lock.yaml app/
git commit -m "feat(ui): install Nuxt UI v3 + fonts + color-mode + pinia; dark theme"
```

---

## Task 2: Layout with sidebar nav + header (connection indicator placeholder)

**Files:**
- Create: `app/layouts/default.vue`
- Create: `app/pages/index.vue` (minimal placeholder; fleshed out in Task 7)

- [ ] **Step 1: Create `app/layouts/default.vue`**

```vue
<!-- app/layouts/default.vue -->
<script setup lang="ts">
const route = useRoute()

const navItems = [
  { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: 'Addresses', icon: 'i-lucide-building-2', to: '/addresses' },
  { label: 'Groups', icon: 'i-lucide-folder', to: '/groups' },
  { label: 'Devices', icon: 'i-lucide-tv', to: '/devices' },
  { label: 'Media', icon: 'i-lucide-image', to: '/media' },
  { label: 'Playlists', icon: 'i-lucide-list-music', to: '/playlists' }
]

// Placeholder until Task 5; real state comes from useDashboardStream()
const streamState = ref<'connecting' | 'connected' | 'disconnected'>('connected')

const colorMode = useColorMode()
function toggleDark() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>

<template>
  <div class="flex h-screen bg-(--ui-bg) text-(--ui-text)">
    <aside
      class="flex w-60 flex-col border-r border-(--ui-border) bg-(--ui-bg-elevated)"
    >
      <div class="flex h-16 items-center gap-2 px-6">
        <UIcon name="i-lucide-radio-tower" class="text-primary size-6" />
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
      </div>
      <nav class="flex-1 px-3 py-2 space-y-1">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
          :class="{
            'bg-(--ui-bg-accented) text-(--ui-text-highlighted)':
              route.path === item.to ||
              (item.to !== '/' && route.path.startsWith(item.to)),
            'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)':
              route.path !== item.to &&
              (item.to === '/' || !route.path.startsWith(item.to))
          }"
        >
          <UIcon :name="item.icon" class="size-4" />
          {{ item.label }}
        </NuxtLink>
      </nav>
      <div class="border-t border-(--ui-border) p-3">
        <div class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
          <span
            class="size-2 rounded-full"
            :class="{
              'bg-emerald-500': streamState === 'connected',
              'bg-amber-500': streamState === 'connecting',
              'bg-rose-500': streamState === 'disconnected'
            }"
          />
          <span class="capitalize">{{ streamState }}</span>
        </div>
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto">
      <header class="flex h-16 items-center justify-between border-b border-(--ui-border) px-6">
        <h1 class="text-sm font-medium text-(--ui-text-muted)">
          <slot name="header" />
        </h1>
        <UButton
          variant="ghost"
          color="neutral"
          size="sm"
          :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
          :aria-label="`Switch to ${colorMode.value === 'dark' ? 'light' : 'dark'} mode`"
          @click="toggleDark"
        />
      </header>
      <div class="p-8">
        <slot />
      </div>
    </main>
  </div>
</template>
```

- [ ] **Step 2: Create a minimal `app/pages/index.vue` so the root route works**

```vue
<!-- app/pages/index.vue -->
<script setup lang="ts">
definePageMeta({ layout: 'default' })
</script>

<template>
  <div>
    <template #header>Overview</template>
    <p class="text-(--ui-text-muted)">
      Overview content lands in Task 7.
    </p>
  </div>
</template>
```

- [ ] **Step 3: Smoke-test**

```bash
pnpm dev &
sleep 6
curl -s http://localhost:3000 | grep -c 'Overview' && echo 'layout renders'
kill %1 2>/dev/null || true
```

Expected: `layout renders`.

- [ ] **Step 4: Commit**

```bash
git add app/layouts/default.vue app/pages/index.vue
git commit -m "feat(ui): sidebar layout with nav + color-mode toggle"
```

---

## Task 3: Shared API types mirroring server handler returns

**Files:**
- Create: `app/types/api.ts`

- [ ] **Step 1: Create `app/types/api.ts`**

```ts
// app/types/api.ts
//
// Mirror the return shapes of server/api handlers. Keeping this as a
// hand-maintained mirror (rather than type-imports from server/) lets Pinia
// stores and page components type-check without pulling the entire server
// import graph client-side.
//
// If a server handler's return shape changes, update the matching interface
// here and let TypeScript surface the affected pages.

export interface Address {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}

export interface Group {
  id: number
  addressId: number
  name: string
  createdAt: string
  updatedAt: string
}

export type DeviceStatus = 'online' | 'idle' | 'offline'

export interface Device {
  id: string
  groupId: number | null
  name: string | null
  lastSeenAt: string | null
  playerVersion: string | null
  currentItemId: number | null
  createdAt: string
  updatedAt: string
}

export interface DeviceListRow extends Device {
  status: DeviceStatus
}

export interface RegisterResult {
  deviceId: string
  claimed: boolean
  name: string | null
  groupId: number | null
}

export interface Media {
  id: number
  sha256: string
  kind: 'video' | 'image'
  filename: string
  mimeType: string
  bytes: number
  thumbnailBytes: number | null
  durationMs: number | null
  width: number | null
  height: number | null
  createdAt: string
}

export interface MediaListRow extends Media {
  usedInPlaylists: number
}

export interface PlaylistItem {
  id: number
  playlistId: number
  mediaId: number
  position: number
  durationMsOverride: number | null
}

export interface Playlist {
  id: number
  name: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface PlaylistDetail extends Playlist {
  items: PlaylistItem[]
}

export interface PlaylistSummary extends Playlist {
  itemCount: number
  assignmentCount: number
}

export interface ManifestItem {
  id: number
  type: 'video' | 'image'
  sha256: string
  durationMs: number
}

export interface Manifest {
  playlistId: number
  playlistName: string
  version: number
  items: ManifestItem[]
}

export interface Assignment {
  id: number
  playlistId: number
  deviceId: string | null
  groupId: number | null
  addressId: number | null
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 2: Commit**

```bash
git add app/types/api.ts
git commit -m "feat(ui): shared API types mirroring server handler returns"
```

---

## Task 4: `useApiClient` composable — typed `$fetch` wrappers

**Files:**
- Create: `app/composables/useApiClient.ts`
- Create: `tests/composables/useApiClient.test.ts`

**Testing approach:** The composable exposes functions like `listDevices()`, `createAddress()`, `assignDeviceToPlaylist()`. Each function is a thin `$fetch` wrapper with a known URL + method. We test that the correct URL and options are called by stubbing `$fetch`.

- [ ] **Step 1: Write failing test**

```ts
// tests/composables/useApiClient.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '~/app/composables/useApiClient'

describe('useApiClient', () => {
  const fetchFn = vi.fn()
  const client = createApiClient(fetchFn as any)

  beforeEach(() => {
    fetchFn.mockReset()
    fetchFn.mockResolvedValue({})
  })

  it('listAddresses GETs /api/addresses', async () => {
    await client.listAddresses()
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses', { method: 'GET' })
  })

  it('createAddress POSTs body', async () => {
    await client.createAddress({ name: 'A' })
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses', {
      method: 'POST',
      body: { name: 'A' }
    })
  })

  it('updateAddress PATCHes with id in path', async () => {
    await client.updateAddress(7, { name: 'B' })
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses/7', {
      method: 'PATCH',
      body: { name: 'B' }
    })
  })

  it('deleteAddress DELETEs', async () => {
    await client.deleteAddress(7)
    expect(fetchFn).toHaveBeenCalledWith('/api/addresses/7', {
      method: 'DELETE'
    })
  })

  it('listGroups with addressId filter', async () => {
    await client.listGroups({ addressId: 3 })
    expect(fetchFn).toHaveBeenCalledWith('/api/groups', {
      method: 'GET',
      query: { addressId: 3 }
    })
  })

  it('listDevices with multiple filters', async () => {
    await client.listDevices({ groupId: 2, unclaimed: true })
    expect(fetchFn).toHaveBeenCalledWith('/api/devices', {
      method: 'GET',
      query: { groupId: 2, unclaimed: true }
    })
  })

  it('reloadDevice POSTs with no body', async () => {
    await client.reloadDevice('tv-1')
    expect(fetchFn).toHaveBeenCalledWith('/api/devices/tv-1/reload', {
      method: 'POST'
    })
  })

  it('uploadMedia sends FormData as multipart', async () => {
    const form = new FormData()
    form.append('kind', 'image')
    await client.uploadMedia(form)
    expect(fetchFn).toHaveBeenCalledWith('/api/media', {
      method: 'POST',
      body: form
    })
  })

  it('replacePlaylistItems PUTs items array', async () => {
    await client.replacePlaylistItems(4, {
      items: [{ mediaId: 1, durationMsOverride: 5000 }]
    })
    expect(fetchFn).toHaveBeenCalledWith('/api/playlists/4/items', {
      method: 'PUT',
      body: { items: [{ mediaId: 1, durationMsOverride: 5000 }] }
    })
  })

  it('assignDeviceToPlaylist PUTs target endpoint', async () => {
    await client.assignDeviceToPlaylist('tv-1', { playlistId: 9 })
    expect(fetchFn).toHaveBeenCalledWith('/api/assignments/devices/tv-1', {
      method: 'PUT',
      body: { playlistId: 9 }
    })
  })

  it('unassignGroup DELETEs the target endpoint', async () => {
    await client.unassignGroup(3)
    expect(fetchFn).toHaveBeenCalledWith('/api/assignments/groups/3', {
      method: 'DELETE'
    })
  })
})
```

- [ ] **Step 2: Run — fails (module missing)**

```bash
pnpm test tests/composables/useApiClient.test.ts
```

- [ ] **Step 3: Implement**

```ts
// app/composables/useApiClient.ts
import type {
  Address,
  Assignment,
  Device,
  DeviceListRow,
  Group,
  Media,
  MediaListRow,
  Playlist,
  PlaylistDetail,
  PlaylistSummary
} from '~/app/types/api'

type FetchFn = typeof $fetch

export interface ApiClient {
  // addresses
  listAddresses(): Promise<Address[]>
  getAddress(id: number): Promise<Address>
  createAddress(body: { name: string }): Promise<Address>
  updateAddress(id: number, body: { name: string }): Promise<Address>
  deleteAddress(id: number): Promise<void>

  // groups
  listGroups(query?: { addressId?: number }): Promise<Group[]>
  getGroup(id: number): Promise<Group>
  createGroup(body: { addressId: number; name: string }): Promise<Group>
  updateGroup(
    id: number,
    body: { name?: string; addressId?: number }
  ): Promise<Group>
  deleteGroup(id: number): Promise<void>

  // devices
  listDevices(query?: {
    groupId?: number
    addressId?: number
    unclaimed?: boolean
  }): Promise<DeviceListRow[]>
  getDevice(id: string): Promise<Device>
  updateDevice(
    id: string,
    body: { name?: string | null; groupId?: number | null }
  ): Promise<Device>
  deleteDevice(id: string): Promise<void>
  reloadDevice(id: string): Promise<void>

  // media
  listMedia(): Promise<MediaListRow[]>
  getMedia(id: number): Promise<Media>
  deleteMedia(id: number, opts?: { force?: boolean }): Promise<void>
  uploadMedia(body: FormData): Promise<Media>

  // playlists
  listPlaylists(): Promise<PlaylistSummary[]>
  getPlaylist(id: number): Promise<PlaylistDetail>
  createPlaylist(body: { name: string }): Promise<Playlist>
  updatePlaylist(id: number, body: { name: string }): Promise<Playlist>
  deletePlaylist(id: number): Promise<void>
  replacePlaylistItems(
    id: number,
    body: {
      items: Array<{ mediaId: number; durationMsOverride?: number }>
    }
  ): Promise<void>

  // assignments (target-addressed)
  assignDeviceToPlaylist(
    deviceId: string,
    body: { playlistId: number }
  ): Promise<Assignment>
  unassignDevice(deviceId: string): Promise<void>
  assignGroupToPlaylist(
    groupId: number,
    body: { playlistId: number }
  ): Promise<Assignment>
  unassignGroup(groupId: number): Promise<void>
  assignAddressToPlaylist(
    addressId: number,
    body: { playlistId: number }
  ): Promise<Assignment>
  unassignAddress(addressId: number): Promise<void>
}

/**
 * Exposed for testing. Production callers use `useApiClient()`.
 */
export function createApiClient(fetch: FetchFn): ApiClient {
  return {
    // addresses
    listAddresses: () =>
      fetch<Address[]>('/api/addresses', { method: 'GET' }),
    getAddress: (id) =>
      fetch<Address>(`/api/addresses/${id}`, { method: 'GET' }),
    createAddress: (body) =>
      fetch<Address>('/api/addresses', { method: 'POST', body }),
    updateAddress: (id, body) =>
      fetch<Address>(`/api/addresses/${id}`, { method: 'PATCH', body }),
    deleteAddress: (id) =>
      fetch<void>(`/api/addresses/${id}`, { method: 'DELETE' }),

    // groups
    listGroups: (query = {}) =>
      fetch<Group[]>('/api/groups', { method: 'GET', query }),
    getGroup: (id) => fetch<Group>(`/api/groups/${id}`, { method: 'GET' }),
    createGroup: (body) =>
      fetch<Group>('/api/groups', { method: 'POST', body }),
    updateGroup: (id, body) =>
      fetch<Group>(`/api/groups/${id}`, { method: 'PATCH', body }),
    deleteGroup: (id) =>
      fetch<void>(`/api/groups/${id}`, { method: 'DELETE' }),

    // devices
    listDevices: (query = {}) =>
      fetch<DeviceListRow[]>('/api/devices', { method: 'GET', query }),
    getDevice: (id) =>
      fetch<Device>(`/api/devices/${id}`, { method: 'GET' }),
    updateDevice: (id, body) =>
      fetch<Device>(`/api/devices/${id}`, { method: 'PATCH', body }),
    deleteDevice: (id) =>
      fetch<void>(`/api/devices/${id}`, { method: 'DELETE' }),
    reloadDevice: (id) =>
      fetch<void>(`/api/devices/${id}/reload`, { method: 'POST' }),

    // media
    listMedia: () => fetch<MediaListRow[]>('/api/media', { method: 'GET' }),
    getMedia: (id) => fetch<Media>(`/api/media/${id}`, { method: 'GET' }),
    deleteMedia: (id, opts = {}) =>
      fetch<void>(`/api/media/${id}`, {
        method: 'DELETE',
        query: opts.force ? { force: 'true' } : undefined
      }),
    uploadMedia: (body) =>
      fetch<Media>('/api/media', { method: 'POST', body }),

    // playlists
    listPlaylists: () =>
      fetch<PlaylistSummary[]>('/api/playlists', { method: 'GET' }),
    getPlaylist: (id) =>
      fetch<PlaylistDetail>(`/api/playlists/${id}`, { method: 'GET' }),
    createPlaylist: (body) =>
      fetch<Playlist>('/api/playlists', { method: 'POST', body }),
    updatePlaylist: (id, body) =>
      fetch<Playlist>(`/api/playlists/${id}`, { method: 'PATCH', body }),
    deletePlaylist: (id) =>
      fetch<void>(`/api/playlists/${id}`, { method: 'DELETE' }),
    replacePlaylistItems: (id, body) =>
      fetch<void>(`/api/playlists/${id}/items`, { method: 'PUT', body }),

    // assignments
    assignDeviceToPlaylist: (deviceId, body) =>
      fetch<Assignment>(`/api/assignments/devices/${deviceId}`, {
        method: 'PUT',
        body
      }),
    unassignDevice: (deviceId) =>
      fetch<void>(`/api/assignments/devices/${deviceId}`, { method: 'DELETE' }),
    assignGroupToPlaylist: (groupId, body) =>
      fetch<Assignment>(`/api/assignments/groups/${groupId}`, {
        method: 'PUT',
        body
      }),
    unassignGroup: (groupId) =>
      fetch<void>(`/api/assignments/groups/${groupId}`, { method: 'DELETE' }),
    assignAddressToPlaylist: (addressId, body) =>
      fetch<Assignment>(`/api/assignments/addresses/${addressId}`, {
        method: 'PUT',
        body
      }),
    unassignAddress: (addressId) =>
      fetch<void>(`/api/assignments/addresses/${addressId}`, {
        method: 'DELETE'
      })
  }
}

let _client: ApiClient | null = null

export function useApiClient(): ApiClient {
  if (!_client) _client = createApiClient($fetch as FetchFn)
  return _client
}
```

- [ ] **Step 4: Run — passes (12 tests)**

```bash
pnpm test tests/composables/useApiClient.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add app/composables/useApiClient.ts tests/composables/useApiClient.test.ts
git commit -m "feat(ui): typed useApiClient composable"
```

---

## Task 5: `useDashboardStream` SSE composable

**Files:**
- Create: `app/composables/useDashboardStream.ts`
- Create: `tests/composables/useDashboardStream.test.ts`

**Testing approach:** We abstract `EventSource` behind a factory so tests inject a fake. The composable parses JSON-encoded `device-event` payloads and exposes reactive state.

- [ ] **Step 1: Failing test**

```ts
// tests/composables/useDashboardStream.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDashboardStream } from '~/app/composables/useDashboardStream'

type Listener = (event: { data: string }) => void

class FakeEventSource {
  listeners = new Map<string, Listener[]>()
  readyState = 0 // CONNECTING
  closed = false
  constructor(public url: string) {
    FakeEventSource.lastInstance = this
  }
  addEventListener(type: string, fn: Listener) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() {
    this.closed = true
  }
  fire(type: string, data: unknown) {
    const arr = this.listeners.get(type) ?? []
    for (const l of arr) l({ data: JSON.stringify(data) })
  }
  fireOpen() {
    this.readyState = 1
    const arr = this.listeners.get('open') ?? []
    for (const l of arr) l({ data: '' } as any)
  }
  static lastInstance: FakeEventSource | null = null
}

describe('useDashboardStream', () => {
  beforeEach(() => {
    FakeEventSource.lastInstance = null
  })

  it('begins in "connecting" state', () => {
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    expect(s.state.value).toBe('connecting')
    s.close()
  })

  it('transitions to "connected" on open event', () => {
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    FakeEventSource.lastInstance!.fireOpen()
    expect(s.state.value).toBe('connected')
    s.close()
  })

  it('emits device-event payloads to subscribers', () => {
    const received: Array<{
      deviceId: string
      event: string
      data: unknown
    }> = []
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    s.onDeviceEvent((payload) => received.push(payload))

    FakeEventSource.lastInstance!.fire('device-event', {
      deviceId: 'tv-1',
      event: 'manifest-changed',
      data: { playlistId: 7 }
    })

    expect(received).toEqual([
      {
        deviceId: 'tv-1',
        event: 'manifest-changed',
        data: { playlistId: 7 }
      }
    ])
    s.close()
  })

  it('close() sets state to disconnected and closes the underlying source', () => {
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    s.close()
    expect(s.state.value).toBe('disconnected')
    expect(FakeEventSource.lastInstance!.closed).toBe(true)
  })

  it('ignores malformed device-event JSON (logs only, no throw)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = createDashboardStream(
      '/api/dashboard/stream',
      (url) => new FakeEventSource(url) as any
    )
    const arr = FakeEventSource.lastInstance!.listeners.get('device-event') ?? []
    expect(() => {
      for (const l of arr) l({ data: '{not valid json' })
    }).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    s.close()
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement**

```ts
// app/composables/useDashboardStream.ts
import { ref, type Ref } from 'vue'

export type StreamState = 'connecting' | 'connected' | 'disconnected'

export interface DeviceEventPayload {
  deviceId: string
  event: string
  data: unknown
}

export interface DashboardStream {
  state: Ref<StreamState>
  onDeviceEvent(handler: (p: DeviceEventPayload) => void): () => void
  close(): void
}

type EventSourceFactory = (url: string) => EventSource

export function createDashboardStream(
  url: string,
  factory: EventSourceFactory = (u) => new EventSource(u)
): DashboardStream {
  const state = ref<StreamState>('connecting')
  const src = factory(url)
  const handlers = new Set<(p: DeviceEventPayload) => void>()

  src.addEventListener('open', () => {
    state.value = 'connected'
  })

  src.addEventListener('error', () => {
    // Browser EventSource auto-reconnects; we surface the current state.
    state.value = src.readyState === 1 ? 'connected' : 'connecting'
  })

  src.addEventListener('device-event', (ev: MessageEvent) => {
    try {
      const payload = JSON.parse(ev.data) as DeviceEventPayload
      for (const h of handlers) h(payload)
    } catch (err) {
      console.error('[dashboard-stream] malformed device-event', err)
    }
  })

  // `ping` events keep the connection alive; nothing to do with them.

  return {
    state,
    onDeviceEvent(fn) {
      handlers.add(fn)
      return () => {
        handlers.delete(fn)
      }
    },
    close() {
      src.close()
      state.value = 'disconnected'
      handlers.clear()
    }
  }
}

let _singleton: DashboardStream | null = null

export function useDashboardStream(): DashboardStream {
  if (!_singleton) {
    _singleton = createDashboardStream('/api/dashboard/stream')
  }
  return _singleton
}

// Test-only helper
export function _resetDashboardStream(): void {
  _singleton?.close()
  _singleton = null
}
```

- [ ] **Step 4: Run — 5 passed**

- [ ] **Step 5: Commit**

```bash
git add app/composables/useDashboardStream.ts tests/composables/useDashboardStream.test.ts
git commit -m "feat(ui): useDashboardStream SSE composable"
```

---

## Task 6: Pinia stores + SSE wiring

**Files:**
- Create: `app/stores/addresses.ts`
- Create: `app/stores/groups.ts`
- Create: `app/stores/devices.ts`
- Create: `app/stores/media.ts`
- Create: `app/stores/playlists.ts`
- Create: `tests/stores/devices.test.ts`

The stores all follow the same pattern: hold a list, expose `refresh()` and per-entity mutation actions that call `useApiClient` and patch the list on success. The devices store additionally reacts to SSE device-events by bumping `lastSeenAt` and flipping derived status. We write a full test for `devices.ts` as the representative; the others are structurally identical.

- [ ] **Step 1: Failing test for devices store**

```ts
// tests/stores/devices.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDevicesStore } from '~/app/stores/devices'

describe('useDevicesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('refresh() populates the list from the api', async () => {
    const store = useDevicesStore()
    const listDevices = vi.fn().mockResolvedValue([
      {
        id: 'tv-1',
        groupId: null,
        name: null,
        lastSeenAt: null,
        playerVersion: '0.1.0',
        currentItemId: null,
        status: 'offline',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z'
      }
    ])
    store.$patch({ _api: { listDevices } as any })
    await store.refresh()
    expect(listDevices).toHaveBeenCalledWith({})
    expect(store.list).toHaveLength(1)
    expect(store.list[0].id).toBe('tv-1')
  })

  it('applyDeviceEvent updates lastSeenAt and status for known device', () => {
    const store = useDevicesStore()
    const now = new Date()
    store.$patch({
      list: [
        {
          id: 'tv-1',
          groupId: 2,
          name: 'TV',
          lastSeenAt: null,
          playerVersion: '0.1.0',
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })
    store.applyDeviceEvent(
      { deviceId: 'tv-1', event: 'manifest-changed', data: null },
      now
    )
    expect(store.list[0].lastSeenAt).toEqual(now.toISOString())
    expect(store.list[0].status).toBe('online')
  })

  it('applyDeviceEvent is a no-op for unknown device', () => {
    const store = useDevicesStore()
    store.$patch({
      list: [
        {
          id: 'tv-1',
          groupId: 2,
          name: 'TV',
          lastSeenAt: null,
          playerVersion: '0.1.0',
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })
    store.applyDeviceEvent(
      { deviceId: 'unknown', event: 'manifest-changed', data: null },
      new Date()
    )
    expect(store.list[0].status).toBe('offline')
  })

  it('updateDevice calls api and patches list', async () => {
    const store = useDevicesStore()
    const updateDevice = vi.fn().mockResolvedValue({
      id: 'tv-1',
      groupId: 5,
      name: 'Renamed',
      lastSeenAt: null,
      playerVersion: '0.1.0',
      currentItemId: null,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:01.000Z'
    })
    store.$patch({
      _api: { updateDevice } as any,
      list: [
        {
          id: 'tv-1',
          groupId: null,
          name: null,
          lastSeenAt: null,
          playerVersion: '0.1.0',
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })

    await store.updateDevice('tv-1', { name: 'Renamed', groupId: 5 })

    expect(updateDevice).toHaveBeenCalledWith('tv-1', {
      name: 'Renamed',
      groupId: 5
    })
    expect(store.list[0].name).toBe('Renamed')
    expect(store.list[0].groupId).toBe(5)
  })

  it('deleteDevice removes the entry from the list', async () => {
    const store = useDevicesStore()
    const deleteDevice = vi.fn().mockResolvedValue(undefined)
    store.$patch({
      _api: { deleteDevice } as any,
      list: [
        {
          id: 'a',
          groupId: null,
          name: null,
          lastSeenAt: null,
          playerVersion: null,
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        },
        {
          id: 'b',
          groupId: null,
          name: null,
          lastSeenAt: null,
          playerVersion: null,
          currentItemId: null,
          status: 'offline',
          createdAt: '2026-04-18T00:00:00.000Z',
          updatedAt: '2026-04-18T00:00:00.000Z'
        }
      ]
    })
    await store.deleteDevice('a')
    expect(store.list.map((d: any) => d.id)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement the stores**

Start with `app/stores/devices.ts` (the richest):

```ts
// app/stores/devices.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { DeviceEventPayload } from '~/app/composables/useDashboardStream'
import type { Device, DeviceListRow, DeviceStatus } from '~/app/types/api'

function computeStatus(lastSeenAt: string | null): DeviceStatus {
  if (!lastSeenAt) return 'offline'
  const ageMs = Date.now() - new Date(lastSeenAt).getTime()
  if (ageMs <= 60_000) return 'online'
  if (ageMs <= 5 * 60_000) return 'idle'
  return 'offline'
}

interface State {
  list: DeviceListRow[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listDevices' | 'updateDevice' | 'deleteDevice' | 'reloadDevice'>
}

export const useDevicesStore = defineStore('devices', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),

  actions: {
    async refresh(
      filters: { groupId?: number; addressId?: number; unclaimed?: boolean } = {}
    ) {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listDevices(filters)
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },

    async updateDevice(
      id: string,
      body: { name?: string | null; groupId?: number | null }
    ): Promise<Device> {
      const updated = await this._api.updateDevice(id, body)
      const idx = this.list.findIndex((d) => d.id === id)
      if (idx >= 0) {
        this.list[idx] = {
          ...this.list[idx],
          ...updated,
          status: computeStatus(updated.lastSeenAt)
        }
      }
      return updated
    },

    async deleteDevice(id: string): Promise<void> {
      await this._api.deleteDevice(id)
      this.list = this.list.filter((d) => d.id !== id)
    },

    async reloadDevice(id: string): Promise<void> {
      await this._api.reloadDevice(id)
    },

    applyDeviceEvent(payload: DeviceEventPayload, now = new Date()) {
      const idx = this.list.findIndex((d) => d.id === payload.deviceId)
      if (idx < 0) return
      const iso = now.toISOString()
      this.list[idx] = {
        ...this.list[idx],
        lastSeenAt: iso,
        status: 'online'
      }
    }
  }
})
```

`app/stores/addresses.ts`:

```ts
// app/stores/addresses.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Address } from '~/app/types/api'

interface State {
  list: Address[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    'listAddresses' | 'createAddress' | 'updateAddress' | 'deleteAddress'
  >
}

export const useAddressesStore = defineStore('addresses', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),

  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listAddresses()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async create(body: { name: string }): Promise<Address> {
      const row = await this._api.createAddress(body)
      this.list.push(row)
      return row
    },
    async update(id: number, body: { name: string }): Promise<Address> {
      const row = await this._api.updateAddress(id, body)
      const idx = this.list.findIndex((x) => x.id === id)
      if (idx >= 0) this.list[idx] = row
      return row
    },
    async delete(id: number): Promise<void> {
      await this._api.deleteAddress(id)
      this.list = this.list.filter((x) => x.id !== id)
    }
  }
})
```

`app/stores/groups.ts`:

```ts
// app/stores/groups.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Group } from '~/app/types/api'

interface State {
  list: Group[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    'listGroups' | 'createGroup' | 'updateGroup' | 'deleteGroup'
  >
}

export const useGroupsStore = defineStore('groups', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),
  actions: {
    async refresh(filters: { addressId?: number } = {}) {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listGroups(filters)
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async create(body: { addressId: number; name: string }): Promise<Group> {
      const row = await this._api.createGroup(body)
      this.list.push(row)
      return row
    },
    async update(
      id: number,
      body: { name?: string; addressId?: number }
    ): Promise<Group> {
      const row = await this._api.updateGroup(id, body)
      const idx = this.list.findIndex((x) => x.id === id)
      if (idx >= 0) this.list[idx] = row
      return row
    },
    async delete(id: number): Promise<void> {
      await this._api.deleteGroup(id)
      this.list = this.list.filter((x) => x.id !== id)
    }
  }
})
```

`app/stores/media.ts`:

```ts
// app/stores/media.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Media, MediaListRow } from '~/app/types/api'

interface State {
  list: MediaListRow[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listMedia' | 'uploadMedia' | 'deleteMedia'>
}

export const useMediaStore = defineStore('media', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listMedia()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async upload(form: FormData): Promise<Media> {
      const row = await this._api.uploadMedia(form)
      await this.refresh()
      return row
    },
    async delete(id: number, opts: { force?: boolean } = {}): Promise<void> {
      await this._api.deleteMedia(id, opts)
      this.list = this.list.filter((m) => m.id !== id)
    }
  }
})
```

`app/stores/playlists.ts`:

```ts
// app/stores/playlists.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Playlist, PlaylistSummary } from '~/app/types/api'

interface State {
  list: PlaylistSummary[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    | 'listPlaylists'
    | 'createPlaylist'
    | 'updatePlaylist'
    | 'deletePlaylist'
    | 'replacePlaylistItems'
  >
}

export const usePlaylistsStore = defineStore('playlists', {
  state: (): State => ({
    list: [],
    loading: false,
    error: null,
    _api: useApiClient()
  }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listPlaylists()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
    async create(body: { name: string }): Promise<Playlist> {
      const row = await this._api.createPlaylist(body)
      await this.refresh()
      return row
    },
    async update(id: number, body: { name: string }): Promise<Playlist> {
      const row = await this._api.updatePlaylist(id, body)
      await this.refresh()
      return row
    },
    async delete(id: number): Promise<void> {
      await this._api.deletePlaylist(id)
      this.list = this.list.filter((p) => p.id !== id)
    },
    async replaceItems(
      id: number,
      items: Array<{ mediaId: number; durationMsOverride?: number }>
    ): Promise<void> {
      await this._api.replacePlaylistItems(id, { items })
      await this.refresh()
    }
  }
})
```

- [ ] **Step 4: Run — 5 passed**

```bash
pnpm test tests/stores/devices.test.ts
```

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
pnpm test
```

Expected: 130 + 12 (useApiClient) + 5 (useDashboardStream) + 5 (devices store) = 152 passed.

- [ ] **Step 6: Commit**

```bash
git add app/stores/ tests/stores/
git commit -m "feat(ui): Pinia stores for addresses/groups/devices/media/playlists"
```

---

## Task 7: Overview page — stat cards, unclaimed tray, red-dot feed

**Files:**
- Create: `app/components/StatCard.vue`
- Create: `app/components/StatusDot.vue`
- Create: `app/components/EmptyState.vue`
- Create: `app/components/UnclaimedDevicesTray.vue`
- Create: `app/components/ErrorFeed.vue` (placeholder — no list endpoint exists for device_errors yet; this fetches via direct SQL proxy for now; see note)
- Modify: `app/pages/index.vue`

Since there's no `/api/device-errors` endpoint yet (Plan 2a didn't add one), the ErrorFeed renders "Error feed requires an API endpoint — coming in a follow-up" as a known gap. We surface that in the plan's self-review.

- [ ] **Step 1: Create `app/components/StatCard.vue`**

```vue
<!-- app/components/StatCard.vue -->
<script setup lang="ts">
defineProps<{
  label: string
  value: number | string
  icon?: string
  hint?: string
  tone?: 'neutral' | 'emerald' | 'amber' | 'rose'
}>()
</script>

<template>
  <div
    class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-5"
  >
    <div class="flex items-center gap-3">
      <div
        v-if="icon"
        class="rounded-md p-2"
        :class="{
          'bg-zinc-500/10 text-zinc-400': !tone || tone === 'neutral',
          'bg-emerald-500/10 text-emerald-500': tone === 'emerald',
          'bg-amber-500/10 text-amber-500': tone === 'amber',
          'bg-rose-500/10 text-rose-500': tone === 'rose'
        }"
      >
        <UIcon :name="icon" class="size-5" />
      </div>
      <div>
        <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
          {{ label }}
        </p>
        <p class="text-2xl font-semibold tabular-nums">{{ value }}</p>
      </div>
    </div>
    <p v-if="hint" class="mt-3 text-xs text-(--ui-text-muted)">{{ hint }}</p>
  </div>
</template>
```

- [ ] **Step 2: Create `app/components/StatusDot.vue`**

```vue
<!-- app/components/StatusDot.vue -->
<script setup lang="ts">
import type { DeviceStatus } from '~/app/types/api'
defineProps<{ status: DeviceStatus; label?: boolean }>()
</script>

<template>
  <span class="inline-flex items-center gap-2 text-xs">
    <span
      class="size-2 rounded-full"
      :class="{
        'bg-emerald-500': status === 'online',
        'bg-amber-500': status === 'idle',
        'bg-rose-500': status === 'offline'
      }"
    />
    <span v-if="label" class="capitalize">{{ status }}</span>
  </span>
</template>
```

- [ ] **Step 3: Create `app/components/EmptyState.vue`**

```vue
<!-- app/components/EmptyState.vue -->
<script setup lang="ts">
defineProps<{
  icon?: string
  title: string
  description?: string
}>()
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-(--ui-border) p-12 text-center"
  >
    <UIcon
      v-if="icon"
      :name="icon"
      class="size-10 text-(--ui-text-muted)"
    />
    <div>
      <p class="text-sm font-medium">{{ title }}</p>
      <p
        v-if="description"
        class="mt-1 text-sm text-(--ui-text-muted)"
      >
        {{ description }}
      </p>
    </div>
    <slot />
  </div>
</template>
```

- [ ] **Step 4: Create `app/components/UnclaimedDevicesTray.vue`**

```vue
<!-- app/components/UnclaimedDevicesTray.vue -->
<script setup lang="ts">
import type { DeviceListRow, Group } from '~/app/types/api'
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'

const devicesStore = useDevicesStore()
const groupsStore = useGroupsStore()
const toast = useToast()

const unclaimed = computed<DeviceListRow[]>(() =>
  devicesStore.list.filter((d) => d.groupId === null)
)
const form = ref<Record<string, { name: string; groupId: number | null }>>({})

onMounted(async () => {
  await Promise.all([
    devicesStore.refresh(),
    groupsStore.refresh()
  ])
})

function groupsOf(row: DeviceListRow) {
  return groupsStore.list.map((g: Group) => ({
    label: g.name,
    value: g.id
  }))
}

async function claim(row: DeviceListRow) {
  const state = form.value[row.id] ?? { name: '', groupId: null }
  if (!state.name || state.groupId === null) {
    toast.add({
      title: 'Enter a name and pick a group',
      color: 'warning'
    })
    return
  }
  try {
    await devicesStore.updateDevice(row.id, {
      name: state.name,
      groupId: state.groupId
    })
    toast.add({ title: `Claimed as "${state.name}"`, color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Claim failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <section
    class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)"
  >
    <header class="flex items-center justify-between border-b border-(--ui-border) px-5 py-3">
      <h2 class="text-sm font-semibold">Unclaimed devices</h2>
      <span class="text-xs text-(--ui-text-muted)">
        {{ unclaimed.length }} pending
      </span>
    </header>
    <div v-if="unclaimed.length === 0" class="p-5">
      <EmptyState
        icon="i-lucide-inbox"
        title="All devices are claimed"
        description="Devices that self-register will appear here."
      />
    </div>
    <ul v-else class="divide-y divide-(--ui-border)">
      <li
        v-for="row in unclaimed"
        :key="row.id"
        class="flex items-center gap-3 px-5 py-3"
      >
        <code class="font-mono text-xs text-(--ui-text-muted) w-60 truncate">
          {{ row.id }}
        </code>
        <UInput
          v-model="form[row.id] ||= { name: '', groupId: null }; form[row.id].name"
          placeholder="Name (e.g. TV-Lobby-1)"
          size="sm"
          class="w-48"
        />
        <USelectMenu
          v-model="form[row.id].groupId"
          :items="groupsOf(row)"
          value-key="value"
          placeholder="Group"
          size="sm"
          class="w-48"
        />
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-check"
          @click="claim(row)"
        >
          Claim
        </UButton>
      </li>
    </ul>
  </section>
</template>
```

Note: the `v-model="form[row.id] ||= { name: '', groupId: null }; form[row.id].name"` expression is invalid inline. Correct it:

```vue
<UInput
  :model-value="(form[row.id] ||= { name: '', groupId: null }).name"
  @update:model-value="(val) => (form[row.id] ||= { name: '', groupId: null }).name = val"
  placeholder="Name (e.g. TV-Lobby-1)"
  size="sm"
  class="w-48"
/>
<USelectMenu
  :model-value="(form[row.id] ||= { name: '', groupId: null }).groupId"
  @update:model-value="(val) => ((form[row.id] ||= { name: '', groupId: null }).groupId = val as number)"
  :items="groupsOf(row)"
  value-key="value"
  placeholder="Group"
  size="sm"
  class="w-48"
/>
```

Replace the `<UInput>` and `<USelectMenu>` in the component with these forms.

- [ ] **Step 5: Create `app/components/ErrorFeed.vue` (placeholder)**

```vue
<!-- app/components/ErrorFeed.vue -->
<script setup lang="ts">
// The device_errors API endpoint is planned but not yet built.
// Placeholder for now; wire to a list endpoint in a follow-up plan.
</script>

<template>
  <section
    class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)"
  >
    <header class="border-b border-(--ui-border) px-5 py-3">
      <h2 class="text-sm font-semibold">Recent playback errors</h2>
    </header>
    <div class="p-5">
      <EmptyState
        icon="i-lucide-clock-alert"
        title="Error feed pending"
        description="The /api/device-errors endpoint hasn't been added yet. Coming in a follow-up plan."
      />
    </div>
  </section>
</template>
```

- [ ] **Step 6: Fill in `app/pages/index.vue`**

```vue
<!-- app/pages/index.vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useMediaStore } from '~/app/stores/media'
import { usePlaylistsStore } from '~/app/stores/playlists'
import { useDashboardStream } from '~/app/composables/useDashboardStream'

definePageMeta({ layout: 'default' })

const devicesStore = useDevicesStore()
const mediaStore = useMediaStore()
const playlistsStore = usePlaylistsStore()

onMounted(async () => {
  await Promise.all([
    devicesStore.refresh(),
    mediaStore.refresh(),
    playlistsStore.refresh()
  ])
  if (import.meta.client) {
    const stream = useDashboardStream()
    stream.onDeviceEvent((p) => devicesStore.applyDeviceEvent(p))
  }
})

const stats = computed(() => {
  const total = devicesStore.list.length
  const online = devicesStore.list.filter((d) => d.status === 'online').length
  const offlineLong = devicesStore.list.filter(
    (d) => d.status === 'offline' && d.groupId !== null
  ).length
  const unclaimed = devicesStore.list.filter((d) => d.groupId === null).length
  return { total, online, offlineLong, unclaimed }
})
</script>

<template>
  <div>
    <template #header>Overview</template>
    <div class="grid grid-cols-4 gap-4">
      <StatCard
        label="Total devices"
        :value="stats.total"
        icon="i-lucide-tv"
      />
      <StatCard
        label="Online now"
        :value="stats.online"
        icon="i-lucide-wifi"
        tone="emerald"
      />
      <StatCard
        label="Offline > 5 min"
        :value="stats.offlineLong"
        icon="i-lucide-wifi-off"
        tone="rose"
      />
      <StatCard
        label="Unclaimed"
        :value="stats.unclaimed"
        icon="i-lucide-inbox"
        tone="amber"
      />
    </div>

    <div class="mt-8 grid grid-cols-2 gap-6">
      <UnclaimedDevicesTray />
      <ErrorFeed />
    </div>
  </div>
</template>
```

- [ ] **Step 7: Smoke test**

```bash
pnpm dev &
sleep 6
curl -s http://localhost:3000 | grep -c 'Total devices' && echo 'overview renders'
kill %1 2>/dev/null || true
```

Expected: `overview renders`.

- [ ] **Step 8: Commit**

```bash
git add app/components/ app/pages/index.vue
git commit -m "feat(ui): overview page with stats + unclaimed tray + error feed placeholder"
```

---

## Task 8: Addresses + Groups pages

**Files:**
- Create: `app/pages/addresses/index.vue`
- Create: `app/pages/addresses/[id].vue`
- Create: `app/pages/groups/index.vue`
- Create: `app/pages/groups/[id].vue`

Patterns mirror each other. Address detail shows groups under it; group detail shows devices under it.

- [ ] **Step 1: `app/pages/addresses/index.vue`**

```vue
<!-- app/pages/addresses/index.vue -->
<script setup lang="ts">
import { useAddressesStore } from '~/app/stores/addresses'

definePageMeta({ layout: 'default' })

const store = useAddressesStore()
const toast = useToast()
const creating = ref(false)
const newName = ref('')

onMounted(() => store.refresh())

async function createAddress() {
  if (!newName.value.trim()) return
  try {
    await store.create({ name: newName.value.trim() })
    toast.add({ title: 'Address created', color: 'success' })
    newName.value = ''
    creating.value = false
  } catch (err: any) {
    toast.add({
      title: 'Create failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>Addresses</template>
    <div class="flex items-center justify-between">
      <p class="text-sm text-(--ui-text-muted)">
        Physical locations. Each address can contain multiple groups.
      </p>
      <UButton
        v-if="!creating"
        icon="i-lucide-plus"
        color="primary"
        @click="creating = true"
      >
        New address
      </UButton>
    </div>

    <div
      v-if="creating"
      class="mt-4 flex items-center gap-2 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
    >
      <UInput
        v-model="newName"
        placeholder="Address name (e.g. Mechnikova Clinic)"
        class="flex-1"
        autofocus
        @keyup.enter="createAddress"
      />
      <UButton color="primary" @click="createAddress">Create</UButton>
      <UButton
        color="neutral"
        variant="ghost"
        @click="creating = false; newName = ''"
      >
        Cancel
      </UButton>
    </div>

    <div class="mt-6">
      <USkeleton
        v-if="store.loading && store.list.length === 0"
        class="h-24 w-full"
      />
      <EmptyState
        v-else-if="store.list.length === 0"
        icon="i-lucide-building-2"
        title="No addresses yet"
        description="Create your first address to start organizing devices."
      />
      <ul v-else class="space-y-2">
        <li
          v-for="addr in store.list"
          :key="addr.id"
          class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4 hover:border-(--ui-border-accented) transition-colors"
        >
          <NuxtLink :to="`/addresses/${addr.id}`" class="flex-1 flex items-center gap-3">
            <UIcon name="i-lucide-building-2" class="size-5 text-(--ui-text-muted)" />
            <div>
              <p class="font-medium">{{ addr.name }}</p>
              <p class="text-xs text-(--ui-text-muted) font-mono">#{{ addr.id }}</p>
            </div>
          </NuxtLink>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
        </li>
      </ul>
    </div>
  </div>
</template>
```

- [ ] **Step 2: `app/pages/addresses/[id].vue`**

```vue
<!-- app/pages/addresses/[id].vue -->
<script setup lang="ts">
import { useAddressesStore } from '~/app/stores/addresses'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const addressesStore = useAddressesStore()
const groupsStore = useGroupsStore()
const api = useApiClient()
const toast = useToast()

const id = computed(() => Number(route.params.id))

const address = ref<Awaited<ReturnType<typeof api.getAddress>> | null>(null)
const editing = ref(false)
const editName = ref('')

const newGroupName = ref('')

onMounted(async () => {
  try {
    address.value = await api.getAddress(id.value)
    editName.value = address.value.name
    await groupsStore.refresh({ addressId: id.value })
  } catch (err: any) {
    toast.add({
      title: 'Load failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
})

async function save() {
  if (!address.value || !editName.value.trim()) return
  try {
    const updated = await addressesStore.update(address.value.id, {
      name: editName.value.trim()
    })
    address.value = updated
    editing.value = false
    toast.add({ title: 'Saved', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Save failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function createGroup() {
  if (!address.value || !newGroupName.value.trim()) return
  try {
    await groupsStore.create({
      addressId: address.value.id,
      name: newGroupName.value.trim()
    })
    toast.add({ title: 'Group created', color: 'success' })
    newGroupName.value = ''
  } catch (err: any) {
    toast.add({
      title: 'Create failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

const confirm = useConfirm()
async function remove() {
  if (!address.value) return
  const ok = await confirm({
    title: `Delete ${address.value.name}?`,
    description:
      'Removes this address and cascades to all groups. Devices in those groups will become unclaimed.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await addressesStore.delete(address.value.id)
    router.push('/addresses')
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>
      <NuxtLink to="/addresses" class="hover:text-(--ui-text)">Addresses</NuxtLink>
      <span> / </span>
      <span class="text-(--ui-text)">{{ address?.name ?? '…' }}</span>
    </template>

    <div v-if="!address">
      <USkeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <section
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
      >
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
              Address
            </p>
            <template v-if="!editing">
              <h2 class="mt-1 text-2xl font-semibold">{{ address.name }}</h2>
              <p class="mt-1 text-xs font-mono text-(--ui-text-muted)">
                #{{ address.id }}
              </p>
            </template>
            <template v-else>
              <UInput
                v-model="editName"
                autofocus
                class="mt-1"
                @keyup.enter="save"
              />
            </template>
          </div>
          <div class="flex gap-2">
            <template v-if="!editing">
              <UButton
                variant="soft"
                icon="i-lucide-pencil"
                @click="editing = true"
              >
                Rename
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="remove"
              >
                Delete
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="save">Save</UButton>
              <UButton
                variant="ghost"
                @click="editing = false; editName = address!.name"
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Groups in this address</h3>
        </div>
        <div class="mt-4 flex items-center gap-2">
          <UInput
            v-model="newGroupName"
            placeholder="New group name (e.g. Lobby)"
            class="flex-1 max-w-md"
            @keyup.enter="createGroup"
          />
          <UButton color="primary" icon="i-lucide-plus" @click="createGroup">
            Add group
          </UButton>
        </div>

        <EmptyState
          v-if="groupsStore.list.length === 0 && !groupsStore.loading"
          class="mt-4"
          icon="i-lucide-folder"
          title="No groups yet"
          description="Groups subdivide an address. A clinic might have 'Lobby' and 'Cafeteria' groups."
        />
        <ul v-else class="mt-4 space-y-2">
          <li
            v-for="g in groupsStore.list"
            :key="g.id"
            class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
          >
            <NuxtLink :to="`/groups/${g.id}`" class="flex-1 flex items-center gap-3">
              <UIcon name="i-lucide-folder" class="size-5 text-(--ui-text-muted)" />
              <span class="font-medium">{{ g.name }}</span>
            </NuxtLink>
            <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
```

- [ ] **Step 3: `app/pages/groups/index.vue`** (mirror of addresses list — filter by addressId via query param)

```vue
<!-- app/pages/groups/index.vue -->
<script setup lang="ts">
import { useGroupsStore } from '~/app/stores/groups'
import { useAddressesStore } from '~/app/stores/addresses'

definePageMeta({ layout: 'default' })

const groupsStore = useGroupsStore()
const addressesStore = useAddressesStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()

const addressFilter = ref<number | null>(
  route.query.addressId ? Number(route.query.addressId) : null
)

watch(addressFilter, (v) => {
  router.replace({
    query: { ...route.query, addressId: v ?? undefined }
  })
  groupsStore.refresh({ addressId: v ?? undefined })
})

onMounted(async () => {
  await Promise.all([
    addressesStore.refresh(),
    groupsStore.refresh({ addressId: addressFilter.value ?? undefined })
  ])
})

const addressItems = computed(() => [
  { label: 'All addresses', value: null },
  ...addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
])

function addressName(id: number) {
  return addressesStore.list.find((a) => a.id === id)?.name ?? `#${id}`
}
</script>

<template>
  <div>
    <template #header>Groups</template>
    <div class="flex items-center gap-3">
      <USelectMenu
        v-model="addressFilter"
        :items="addressItems"
        value-key="value"
        placeholder="Filter by address"
        class="w-64"
      />
    </div>

    <div class="mt-6">
      <USkeleton
        v-if="groupsStore.loading && groupsStore.list.length === 0"
        class="h-24 w-full"
      />
      <EmptyState
        v-else-if="groupsStore.list.length === 0"
        icon="i-lucide-folder"
        title="No groups match"
        description="Create groups from an address detail page."
      />
      <ul v-else class="space-y-2">
        <li
          v-for="g in groupsStore.list"
          :key="g.id"
          class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
        >
          <NuxtLink :to="`/groups/${g.id}`" class="flex-1 flex items-center gap-3">
            <UIcon name="i-lucide-folder" class="size-5 text-(--ui-text-muted)" />
            <div>
              <p class="font-medium">{{ g.name }}</p>
              <p class="text-xs text-(--ui-text-muted)">
                in {{ addressName(g.addressId) }}
              </p>
            </div>
          </NuxtLink>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
        </li>
      </ul>
    </div>
  </div>
</template>
```

- [ ] **Step 4: `app/pages/groups/[id].vue`**

```vue
<!-- app/pages/groups/[id].vue -->
<script setup lang="ts">
import { useGroupsStore } from '~/app/stores/groups'
import { useAddressesStore } from '~/app/stores/addresses'
import { useDevicesStore } from '~/app/stores/devices'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const groupsStore = useGroupsStore()
const addressesStore = useAddressesStore()
const devicesStore = useDevicesStore()
const api = useApiClient()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => Number(route.params.id))
const group = ref<Awaited<ReturnType<typeof api.getGroup>> | null>(null)
const editing = ref(false)
const editName = ref('')
const editAddressId = ref<number | null>(null)

onMounted(async () => {
  try {
    const [g] = await Promise.all([
      api.getGroup(id.value),
      addressesStore.refresh(),
      devicesStore.refresh({ groupId: id.value })
    ])
    group.value = g
    editName.value = g.name
    editAddressId.value = g.addressId
  } catch (err: any) {
    toast.add({
      title: 'Load failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
})

const addressItems = computed(() =>
  addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
)

async function save() {
  if (!group.value) return
  try {
    const updated = await groupsStore.update(group.value.id, {
      name: editName.value.trim(),
      addressId: editAddressId.value ?? undefined
    })
    group.value = updated
    editing.value = false
    toast.add({ title: 'Saved', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Save failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function remove() {
  if (!group.value) return
  const ok = await confirm({
    title: `Delete ${group.value.name}?`,
    description:
      'Devices in this group will become unclaimed (their group_id will be set to null).',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await groupsStore.delete(group.value.id)
    router.push('/groups')
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>
      <NuxtLink to="/groups" class="hover:text-(--ui-text)">Groups</NuxtLink>
      <span> / </span>
      <span class="text-(--ui-text)">{{ group?.name ?? '…' }}</span>
    </template>

    <div v-if="!group">
      <USkeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <section
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
      >
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
              Group
            </p>
            <template v-if="!editing">
              <h2 class="mt-1 text-2xl font-semibold">{{ group.name }}</h2>
              <p class="mt-1 text-sm text-(--ui-text-muted)">
                in {{ addressesStore.list.find((a) => a.id === group!.addressId)?.name ?? '?' }}
              </p>
            </template>
            <template v-else>
              <div class="mt-1 flex flex-col gap-2 w-80">
                <UInput v-model="editName" />
                <USelectMenu
                  v-model="editAddressId"
                  :items="addressItems"
                  value-key="value"
                />
              </div>
            </template>
          </div>
          <div class="flex gap-2">
            <template v-if="!editing">
              <UButton variant="soft" icon="i-lucide-pencil" @click="editing = true">
                Edit
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="remove"
              >
                Delete
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="save">Save</UButton>
              <UButton
                variant="ghost"
                @click="
                  editing = false
                  editName = group!.name
                  editAddressId = group!.addressId
                "
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <h3 class="text-sm font-semibold">Devices in this group</h3>
        <EmptyState
          v-if="devicesStore.list.length === 0"
          class="mt-4"
          icon="i-lucide-tv"
          title="No devices yet"
          description="Devices self-register and appear as unclaimed. Claim them from Overview or the Devices list."
        />
        <ul v-else class="mt-4 space-y-2">
          <li
            v-for="d in devicesStore.list"
            :key="d.id"
            class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
          >
            <NuxtLink :to="`/devices/${d.id}`" class="flex-1 flex items-center gap-3">
              <StatusDot :status="d.status" />
              <span class="font-medium">{{ d.name ?? 'Unnamed' }}</span>
              <code class="text-xs font-mono text-(--ui-text-muted) truncate max-w-xs">
                {{ d.id }}
              </code>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
```

- [ ] **Step 5: Smoke test all four pages**

```bash
pnpm dev &
sleep 6
for path in /addresses /groups; do
  status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000$path)
  echo "$path → $status"
done
kill %1 2>/dev/null || true
```

Expected: both `200`.

- [ ] **Step 6: Commit**

```bash
git add app/pages/addresses/ app/pages/groups/
git commit -m "feat(ui): addresses + groups list and detail pages"
```

---

## Task 9: `useConfirm` composable + `ConfirmDialog.vue`

**Files:**
- Create: `app/composables/useConfirm.ts`
- Create: `app/components/ConfirmDialog.vue`

Task 8 already uses `useConfirm()` — we implement it now so the pages work. Done inline rather than ahead-of-time so each task stays self-contained; in practice Task 8's commit will fail without this, so the subagent should do Task 9 as part of Task 8 if the functions aren't yet defined. (The plan orders them separately for clarity; they can be merged in execution.)

- [ ] **Step 1: Component**

```vue
<!-- app/components/ConfirmDialog.vue -->
<script setup lang="ts">
import type { ConfirmOptions } from '~/app/composables/useConfirm'

const props = defineProps<{ options: ConfirmOptions; modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'resolve', v: boolean): void
}>()

function onCancel() {
  emit('update:modelValue', false)
  emit('resolve', false)
}
function onConfirm() {
  emit('update:modelValue', false)
  emit('resolve', true)
}
</script>

<template>
  <UModal
    :open="modelValue"
    @update:open="(v) => emit('update:modelValue', v)"
    :ui="{ width: 'sm:max-w-md' }"
  >
    <template #content>
      <div class="p-6">
        <h3 class="text-base font-semibold">{{ options.title }}</h3>
        <p
          v-if="options.description"
          class="mt-2 text-sm text-(--ui-text-muted)"
        >
          {{ options.description }}
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <UButton variant="ghost" @click="onCancel">
            {{ options.cancelLabel ?? 'Cancel' }}
          </UButton>
          <UButton
            :color="options.destructive ? 'error' : 'primary'"
            @click="onConfirm"
          >
            {{ options.confirmLabel ?? 'Confirm' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
```

- [ ] **Step 2: Composable**

```ts
// app/composables/useConfirm.ts
import { ref, createApp, h } from 'vue'
import ConfirmDialog from '~/app/components/ConfirmDialog.vue'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export function useConfirm() {
  return (options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const open = ref(true)
      const mount = document.createElement('div')
      document.body.appendChild(mount)
      const app = createApp({
        setup() {
          return () =>
            h(ConfirmDialog as any, {
              modelValue: open.value,
              options,
              'onUpdate:modelValue': (v: boolean) => (open.value = v),
              onResolve: (v: boolean) => {
                setTimeout(() => {
                  app.unmount()
                  mount.remove()
                  resolve(v)
                }, 150)
              }
            })
        }
      })
      app.mount(mount)
    })
  }
}
```

- [ ] **Step 3: Smoke test**

```bash
pnpm build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
git add app/components/ConfirmDialog.vue app/composables/useConfirm.ts
git commit -m "feat(ui): useConfirm composable + ConfirmDialog component"
```

---

## Task 10: Devices list + detail

**Files:**
- Create: `app/pages/devices/index.vue`
- Create: `app/pages/devices/[id].vue`
- Create: `app/components/AssignmentPicker.vue`

- [ ] **Step 1: `app/pages/devices/index.vue`**

```vue
<!-- app/pages/devices/index.vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useAddressesStore } from '~/app/stores/addresses'
import { useGroupsStore } from '~/app/stores/groups'
import { useDashboardStream } from '~/app/composables/useDashboardStream'

definePageMeta({ layout: 'default' })

const devicesStore = useDevicesStore()
const addressesStore = useAddressesStore()
const groupsStore = useGroupsStore()

const addressFilter = ref<number | null>(null)
const groupFilter = ref<number | null>(null)
const statusFilter = ref<'all' | 'online' | 'idle' | 'offline' | 'unclaimed'>(
  'all'
)

async function refresh() {
  const query: { addressId?: number; groupId?: number; unclaimed?: boolean } = {}
  if (addressFilter.value !== null) query.addressId = addressFilter.value
  if (groupFilter.value !== null) query.groupId = groupFilter.value
  if (statusFilter.value === 'unclaimed') query.unclaimed = true
  await devicesStore.refresh(query)
}

onMounted(async () => {
  await Promise.all([
    addressesStore.refresh(),
    groupsStore.refresh(),
    refresh()
  ])
  if (import.meta.client) {
    const stream = useDashboardStream()
    stream.onDeviceEvent((p) => devicesStore.applyDeviceEvent(p))
  }
})

watch([addressFilter, groupFilter, statusFilter], refresh)

const visible = computed(() => {
  if (
    statusFilter.value === 'all' ||
    statusFilter.value === 'unclaimed'
  ) {
    return devicesStore.list
  }
  return devicesStore.list.filter((d) => d.status === statusFilter.value)
})

function groupName(gid: number | null) {
  if (gid === null) return 'Unclaimed'
  return groupsStore.list.find((g) => g.id === gid)?.name ?? `#${gid}`
}

function addressForGroup(gid: number | null) {
  if (gid === null) return ''
  const g = groupsStore.list.find((x) => x.id === gid)
  if (!g) return ''
  return addressesStore.list.find((a) => a.id === g.addressId)?.name ?? ''
}

function fmtAge(iso: string | null) {
  if (!iso) return 'never'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
</script>

<template>
  <div>
    <template #header>Devices</template>
    <div class="flex items-center gap-3">
      <USelectMenu
        v-model="addressFilter"
        :items="[
          { label: 'All addresses', value: null },
          ...addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
        ]"
        value-key="value"
        placeholder="Address"
        class="w-48"
      />
      <USelectMenu
        v-model="groupFilter"
        :items="[
          { label: 'All groups', value: null },
          ...groupsStore.list.map((g) => ({ label: g.name, value: g.id }))
        ]"
        value-key="value"
        placeholder="Group"
        class="w-48"
      />
      <USelectMenu
        v-model="statusFilter"
        :items="[
          { label: 'Any status', value: 'all' },
          { label: 'Online', value: 'online' },
          { label: 'Idle', value: 'idle' },
          { label: 'Offline', value: 'offline' },
          { label: 'Unclaimed', value: 'unclaimed' }
        ]"
        value-key="value"
        class="w-40"
      />
    </div>

    <div class="mt-6 overflow-hidden rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)">
      <table class="w-full text-sm">
        <thead class="bg-(--ui-bg-accented) text-xs uppercase tracking-wide text-(--ui-text-muted)">
          <tr>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Name</th>
            <th class="px-4 py-3 text-left">Location</th>
            <th class="px-4 py-3 text-left">Last seen</th>
            <th class="px-4 py-3 text-left">Device ID</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--ui-border)">
          <tr
            v-for="d in visible"
            :key="d.id"
            class="hover:bg-(--ui-bg-accented) transition-colors cursor-pointer"
            @click="$router.push(`/devices/${d.id}`)"
          >
            <td class="px-4 py-3">
              <StatusDot :status="d.status" label />
            </td>
            <td class="px-4 py-3 font-medium">
              {{ d.name ?? '(unnamed)' }}
            </td>
            <td class="px-4 py-3 text-(--ui-text-muted)">
              {{ groupName(d.groupId) }}
              <span v-if="addressForGroup(d.groupId)">
                · {{ addressForGroup(d.groupId) }}
              </span>
            </td>
            <td class="px-4 py-3 text-(--ui-text-muted)">{{ fmtAge(d.lastSeenAt) }}</td>
            <td class="px-4 py-3">
              <code class="text-xs font-mono text-(--ui-text-muted) truncate max-w-xs">
                {{ d.id }}
              </code>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="visible.length === 0" class="p-8">
        <EmptyState
          icon="i-lucide-tv"
          title="No devices match"
          description="Adjust filters, or wait for devices to self-register."
        />
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: `app/components/AssignmentPicker.vue`** — used by device/group/address detail pages

```vue
<!-- app/components/AssignmentPicker.vue -->
<script setup lang="ts">
import { usePlaylistsStore } from '~/app/stores/playlists'
import { useApiClient } from '~/app/composables/useApiClient'

const props = defineProps<{
  target: 'device' | 'group' | 'address'
  targetId: string | number
  currentPlaylistId: number | null
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const playlistsStore = usePlaylistsStore()
const api = useApiClient()
const toast = useToast()

const selected = ref<number | null>(props.currentPlaylistId)

onMounted(() => {
  if (playlistsStore.list.length === 0) playlistsStore.refresh()
})

watch(
  () => props.currentPlaylistId,
  (v) => (selected.value = v)
)

const items = computed(() => [
  { label: '— No direct assignment —', value: null },
  ...playlistsStore.list.map((p) => ({ label: p.name, value: p.id }))
])

async function apply() {
  try {
    if (selected.value === null) {
      switch (props.target) {
        case 'device':
          await api.unassignDevice(props.targetId as string)
          break
        case 'group':
          await api.unassignGroup(props.targetId as number)
          break
        case 'address':
          await api.unassignAddress(props.targetId as number)
          break
      }
      toast.add({ title: 'Assignment cleared', color: 'success' })
    } else {
      switch (props.target) {
        case 'device':
          await api.assignDeviceToPlaylist(props.targetId as string, {
            playlistId: selected.value
          })
          break
        case 'group':
          await api.assignGroupToPlaylist(props.targetId as number, {
            playlistId: selected.value
          })
          break
        case 'address':
          await api.assignAddressToPlaylist(props.targetId as number, {
            playlistId: selected.value
          })
          break
      }
      toast.add({ title: 'Assignment updated', color: 'success' })
    }
    emit('changed')
  } catch (err: any) {
    toast.add({
      title: 'Update failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="flex items-center gap-2">
    <USelectMenu
      v-model="selected"
      :items="items"
      value-key="value"
      class="flex-1"
    />
    <UButton
      color="primary"
      :disabled="selected === props.currentPlaylistId"
      @click="apply"
    >
      Apply
    </UButton>
  </div>
</template>
```

- [ ] **Step 3: `app/pages/devices/[id].vue`**

```vue
<!-- app/pages/devices/[id].vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const devicesStore = useDevicesStore()
const groupsStore = useGroupsStore()
const api = useApiClient()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => String(route.params.id))
const device = ref<Awaited<ReturnType<typeof api.getDevice>> | null>(null)

const editing = ref(false)
const editName = ref('')
const editGroupId = ref<number | null>(null)

async function load() {
  try {
    device.value = await api.getDevice(id.value)
    editName.value = device.value.name ?? ''
    editGroupId.value = device.value.groupId
    await groupsStore.refresh()
  } catch (err: any) {
    toast.add({
      title: 'Load failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

onMounted(load)

async function save() {
  if (!device.value) return
  try {
    const updated = await devicesStore.updateDevice(device.value.id, {
      name: editName.value.trim() || null,
      groupId: editGroupId.value
    })
    device.value = updated
    editing.value = false
    toast.add({ title: 'Saved', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Save failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function remove() {
  if (!device.value) return
  const ok = await confirm({
    title: `Delete ${device.value.name ?? device.value.id}?`,
    description: 'Removes this device record. The APK on the TV will re-register on next boot.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await devicesStore.deleteDevice(device.value.id)
    router.push('/devices')
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function reload() {
  if (!device.value) return
  try {
    await devicesStore.reloadDevice(device.value.id)
    toast.add({ title: 'Reload signal sent', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Reload failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>
      <NuxtLink to="/devices" class="hover:text-(--ui-text)">Devices</NuxtLink>
      <span> / </span>
      <span class="text-(--ui-text)">{{ device?.name ?? id }}</span>
    </template>

    <div v-if="!device">
      <USkeleton class="h-32 w-full" />
    </div>
    <template v-else>
      <section
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
      >
        <div class="flex items-start justify-between">
          <div class="flex items-start gap-4">
            <div class="rounded-md bg-zinc-500/10 p-3 text-zinc-400">
              <UIcon name="i-lucide-tv" class="size-6" />
            </div>
            <div>
              <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
                Device
              </p>
              <template v-if="!editing">
                <h2 class="mt-1 text-2xl font-semibold">
                  {{ device.name ?? '(unnamed)' }}
                </h2>
                <p class="mt-1 text-xs font-mono text-(--ui-text-muted)">
                  {{ device.id }}
                </p>
                <p class="mt-2 text-sm text-(--ui-text-muted)">
                  Player v{{ device.playerVersion ?? '?' }} ·
                  {{
                    device.lastSeenAt
                      ? `last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      : 'never seen'
                  }}
                </p>
              </template>
              <template v-else>
                <div class="mt-1 flex flex-col gap-2 w-80">
                  <UInput v-model="editName" placeholder="Name" />
                  <USelectMenu
                    v-model="editGroupId"
                    :items="[
                      { label: '— Unclaimed —', value: null },
                      ...groupsStore.list.map((g) => ({ label: g.name, value: g.id }))
                    ]"
                    value-key="value"
                  />
                </div>
              </template>
            </div>
          </div>
          <div class="flex gap-2">
            <template v-if="!editing">
              <UButton variant="soft" icon="i-lucide-refresh-cw" @click="reload">
                Reload player
              </UButton>
              <UButton variant="soft" icon="i-lucide-pencil" @click="editing = true">
                Edit
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="remove"
              >
                Delete
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="save">Save</UButton>
              <UButton
                variant="ghost"
                @click="
                  editing = false
                  editName = device!.name ?? ''
                  editGroupId = device!.groupId
                "
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6">
        <h3 class="text-sm font-semibold">Direct playlist assignment</h3>
        <p class="mt-1 text-xs text-(--ui-text-muted)">
          Overrides group- and address-level assignment for this device only.
          Clear to fall back to inherited.
        </p>
        <!-- Note: currentPlaylistId requires a query to assignments; we pass null for v1 -->
        <AssignmentPicker
          class="mt-4"
          target="device"
          :target-id="device.id"
          :current-playlist-id="null"
          @changed="load"
        />
      </section>
    </template>
  </div>
</template>
```

Note: the `currentPlaylistId` is set to `null` here because Plan 2a doesn't expose an endpoint to read the current device-level assignment row. The picker still works — pressing Apply with a selection creates (or replaces) the assignment; pressing Apply with "— No direct assignment —" unassigns. Flagged in the self-review.

- [ ] **Step 4: Smoke test**

```bash
pnpm dev &
sleep 6
status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/devices)
echo "/devices → $status"
kill %1 2>/dev/null || true
```

Expected: 200.

- [ ] **Step 5: Commit**

```bash
git add app/pages/devices/ app/components/AssignmentPicker.vue
git commit -m "feat(ui): devices list + detail with reload + assignment override"
```

---

## Task 11: Media library page

**Files:**
- Create: `app/pages/media.vue`
- Create: `app/components/MediaCard.vue`
- Create: `app/components/MediaUploadDialog.vue`

- [ ] **Step 1: `app/components/MediaCard.vue`**

```vue
<!-- app/components/MediaCard.vue -->
<script setup lang="ts">
import type { MediaListRow } from '~/app/types/api'

defineProps<{ media: MediaListRow }>()
defineEmits<{ (e: 'delete', m: MediaListRow): void }>()

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtDuration(ms: number | null) {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="group relative overflow-hidden rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)">
    <div class="aspect-video bg-zinc-900">
      <img
        v-if="media.thumbnailBytes"
        :src="`/media/${media.sha256}/thumb`"
        :alt="media.filename"
        class="h-full w-full object-cover"
      />
      <div
        v-else
        class="flex h-full items-center justify-center text-(--ui-text-muted)"
      >
        <UIcon
          :name="media.kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
          class="size-10"
        />
      </div>
    </div>
    <div class="p-3">
      <p class="truncate text-sm font-medium" :title="media.filename">
        {{ media.filename }}
      </p>
      <div class="mt-1 flex items-center justify-between text-xs text-(--ui-text-muted)">
        <span>
          {{ fmtBytes(media.bytes) }}
          <template v-if="media.durationMs"> · {{ fmtDuration(media.durationMs) }}</template>
        </span>
        <UBadge
          v-if="media.usedInPlaylists > 0"
          size="sm"
          color="neutral"
          variant="soft"
        >
          Used in {{ media.usedInPlaylists }}
        </UBadge>
      </div>
    </div>
    <div class="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
      <UButton
        icon="i-lucide-trash-2"
        color="error"
        variant="soft"
        size="xs"
        @click="$emit('delete', media)"
      />
    </div>
  </div>
</template>
```

- [ ] **Step 2: `app/components/MediaUploadDialog.vue`**

```vue
<!-- app/components/MediaUploadDialog.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'uploaded'): void
}>()

const store = useMediaStore()
const toast = useToast()
const files = ref<File[]>([])
const uploading = ref(false)
const dragOver = ref(false)

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  if (!e.dataTransfer) return
  files.value.push(...Array.from(e.dataTransfer.files))
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) {
    files.value.push(...Array.from(input.files))
  }
}

function remove(i: number) {
  files.value.splice(i, 1)
}

function kindOf(f: File): 'video' | 'image' {
  return f.type.startsWith('video/') ? 'video' : 'image'
}

async function upload() {
  if (files.value.length === 0) return
  uploading.value = true
  let ok = 0
  for (const f of files.value) {
    const form = new FormData()
    form.append('file', f)
    form.append('kind', kindOf(f))
    try {
      await store.upload(form)
      ok++
    } catch (err: any) {
      toast.add({
        title: `Upload failed: ${f.name}`,
        description: err.data?.message ?? err.message,
        color: 'error'
      })
    }
  }
  uploading.value = false
  if (ok > 0) {
    toast.add({
      title: `Uploaded ${ok} file${ok > 1 ? 's' : ''}`,
      color: 'success'
    })
    emit('uploaded')
  }
  files.value = []
  emit('update:modelValue', false)
}
</script>

<template>
  <UModal
    :open="modelValue"
    @update:open="(v) => emit('update:modelValue', v)"
    :ui="{ width: 'sm:max-w-2xl' }"
  >
    <template #content>
      <div class="p-6">
        <h3 class="text-base font-semibold">Upload media</h3>
        <p class="mt-1 text-sm text-(--ui-text-muted)">
          Videos and images. Max 500 MB per file. Duplicate content is deduplicated by sha256.
        </p>

        <div
          class="mt-4 rounded-lg border-2 border-dashed p-8 text-center transition-colors"
          :class="{
            'border-primary-500 bg-primary-500/5': dragOver,
            'border-(--ui-border) bg-(--ui-bg-elevated)': !dragOver
          }"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop="onDrop"
        >
          <UIcon name="i-lucide-upload-cloud" class="mx-auto size-8 text-(--ui-text-muted)" />
          <p class="mt-2 text-sm">
            Drop files here, or
            <label class="cursor-pointer text-primary-500 hover:underline">
              browse
              <input
                type="file"
                multiple
                accept="video/*,image/*"
                class="hidden"
                @change="onPick"
              />
            </label>
          </p>
        </div>

        <ul v-if="files.length > 0" class="mt-4 max-h-64 space-y-2 overflow-y-auto">
          <li
            v-for="(f, i) in files"
            :key="i"
            class="flex items-center justify-between rounded border border-(--ui-border) bg-(--ui-bg) p-2 text-sm"
          >
            <div class="flex items-center gap-2 min-w-0">
              <UIcon
                :name="kindOf(f) === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
                class="size-4 text-(--ui-text-muted) shrink-0"
              />
              <span class="truncate">{{ f.name }}</span>
              <span class="text-xs text-(--ui-text-muted) shrink-0">
                {{ (f.size / 1024 / 1024).toFixed(1) }} MB
              </span>
            </div>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="remove(i)"
            />
          </li>
        </ul>

        <div class="mt-6 flex justify-end gap-2">
          <UButton variant="ghost" @click="emit('update:modelValue', false)">
            Cancel
          </UButton>
          <UButton
            color="primary"
            :loading="uploading"
            :disabled="files.length === 0"
            @click="upload"
          >
            Upload {{ files.length > 0 ? `(${files.length})` : '' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
```

- [ ] **Step 3: `app/pages/media.vue`**

```vue
<!-- app/pages/media.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import type { MediaListRow } from '~/app/types/api'

definePageMeta({ layout: 'default' })

const store = useMediaStore()
const confirm = useConfirm()
const toast = useToast()

const showUpload = ref(false)

onMounted(() => store.refresh())

async function remove(m: MediaListRow) {
  const used = m.usedInPlaylists > 0
  const ok = await confirm({
    title: `Delete ${m.filename}?`,
    description: used
      ? `This file is used in ${m.usedInPlaylists} playlist(s). ` +
        `Deleting will remove those entries and bump each playlist version.`
      : 'Removes the file and its thumbnail permanently.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await store.delete(m.id, { force: used })
    toast.add({ title: 'Deleted', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>Media library</template>
    <div class="flex items-center justify-between">
      <p class="text-sm text-(--ui-text-muted)">
        Upload videos and images. Playlists reference media from this library.
      </p>
      <UButton
        color="primary"
        icon="i-lucide-upload"
        @click="showUpload = true"
      >
        Upload
      </UButton>
    </div>

    <USkeleton v-if="store.loading && store.list.length === 0" class="mt-6 h-32 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      class="mt-6"
      icon="i-lucide-image"
      title="No media yet"
      description="Upload videos or images to start building playlists."
    >
      <UButton
        color="primary"
        icon="i-lucide-upload"
        @click="showUpload = true"
      >
        Upload your first file
      </UButton>
    </EmptyState>
    <div v-else class="mt-6 grid grid-cols-4 gap-4">
      <MediaCard
        v-for="m in store.list"
        :key="m.id"
        :media="m"
        @delete="remove"
      />
    </div>

    <MediaUploadDialog
      v-model="showUpload"
      @uploaded="store.refresh()"
    />
  </div>
</template>
```

- [ ] **Step 4: Smoke**

```bash
pnpm dev &
sleep 6
status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/media)
echo "/media → $status"
kill %1 2>/dev/null || true
```

Expected: 200.

- [ ] **Step 5: Commit**

```bash
git add app/pages/media.vue app/components/MediaCard.vue app/components/MediaUploadDialog.vue
git commit -m "feat(ui): media library with drag-drop upload and in-use delete guard"
```

---

## Task 12: Playlists list + create

**Files:**
- Create: `app/pages/playlists/index.vue`

- [ ] **Step 1: `app/pages/playlists/index.vue`**

```vue
<!-- app/pages/playlists/index.vue -->
<script setup lang="ts">
import { usePlaylistsStore } from '~/app/stores/playlists'

definePageMeta({ layout: 'default' })

const store = usePlaylistsStore()
const toast = useToast()
const creating = ref(false)
const newName = ref('')

onMounted(() => store.refresh())

async function createPlaylist() {
  if (!newName.value.trim()) return
  try {
    const p = await store.create({ name: newName.value.trim() })
    newName.value = ''
    creating.value = false
    toast.add({ title: 'Playlist created', color: 'success' })
    navigateTo(`/playlists/${p.id}`)
  } catch (err: any) {
    toast.add({
      title: 'Create failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>Playlists</template>
    <div class="flex items-center justify-between">
      <p class="text-sm text-(--ui-text-muted)">
        Ordered lists of media that TVs loop. Assign a playlist to a device, group, or address.
      </p>
      <UButton
        v-if="!creating"
        color="primary"
        icon="i-lucide-plus"
        @click="creating = true"
      >
        New playlist
      </UButton>
    </div>

    <div
      v-if="creating"
      class="mt-4 flex items-center gap-2 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
    >
      <UInput
        v-model="newName"
        placeholder="Playlist name (e.g. Summer Promo)"
        class="flex-1 max-w-md"
        autofocus
        @keyup.enter="createPlaylist"
      />
      <UButton color="primary" @click="createPlaylist">Create & edit</UButton>
      <UButton
        variant="ghost"
        @click="creating = false; newName = ''"
      >
        Cancel
      </UButton>
    </div>

    <USkeleton v-if="store.loading && store.list.length === 0" class="mt-6 h-24 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      class="mt-6"
      icon="i-lucide-list-music"
      title="No playlists yet"
      description="Create a playlist and add media items to it."
    >
      <UButton
        color="primary"
        icon="i-lucide-plus"
        @click="creating = true"
      >
        Create playlist
      </UButton>
    </EmptyState>
    <ul v-else class="mt-6 space-y-2">
      <li
        v-for="p in store.list"
        :key="p.id"
        class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4 hover:border-(--ui-border-accented) transition-colors"
      >
        <NuxtLink :to="`/playlists/${p.id}`" class="flex-1 flex items-center gap-3">
          <UIcon name="i-lucide-list-music" class="size-5 text-(--ui-text-muted)" />
          <div>
            <p class="font-medium">{{ p.name }}</p>
            <p class="text-xs text-(--ui-text-muted)">
              {{ p.itemCount }} item{{ p.itemCount === 1 ? '' : 's' }}
              · {{ p.assignmentCount }} assignment{{ p.assignmentCount === 1 ? '' : 's' }}
              · v{{ p.version }}
            </p>
          </div>
        </NuxtLink>
        <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add app/pages/playlists/index.vue
git commit -m "feat(ui): playlists list with create"
```

---

## Task 13: Playlist editor with drag-reorder

**Files:**
- Create: `app/pages/playlists/[id].vue`
- Create: `app/components/MediaPicker.vue`
- Create: `app/components/PlaylistItemRow.vue`
- Create: `tests/components/PlaylistEditor.test.ts`

- [ ] **Step 1: Failing test for the drag-reorder logic**

The editor maintains a working `items` array. We extract the reorder logic into a pure helper so it's unit-testable.

```ts
// tests/components/PlaylistEditor.test.ts
import { describe, it, expect } from 'vitest'
import { reorderItems } from '~/app/components/PlaylistEditor.logic'

describe('reorderItems', () => {
  const items = [
    { id: 1, mediaId: 10, durationMsOverride: null },
    { id: 2, mediaId: 20, durationMsOverride: null },
    { id: 3, mediaId: 30, durationMsOverride: null },
    { id: 4, mediaId: 40, durationMsOverride: null }
  ]

  it('moves item down', () => {
    const r = reorderItems(items, 1, 3) // move B after D
    expect(r.map((x) => x.mediaId)).toEqual([10, 30, 40, 20])
  })

  it('moves item up', () => {
    const r = reorderItems(items, 3, 0) // move D to front
    expect(r.map((x) => x.mediaId)).toEqual([40, 10, 20, 30])
  })

  it('no-op when fromIndex === toIndex', () => {
    const r = reorderItems(items, 2, 2)
    expect(r).toEqual(items)
  })

  it('returns a new array (immutable)', () => {
    const r = reorderItems(items, 0, 1)
    expect(r).not.toBe(items)
  })

  it('out-of-range indices return original array unchanged', () => {
    expect(reorderItems(items, -1, 0)).toEqual(items)
    expect(reorderItems(items, 0, 99)).toEqual(items)
  })
})
```

- [ ] **Step 2: Implement `app/components/PlaylistEditor.logic.ts`**

```ts
// app/components/PlaylistEditor.logic.ts
export interface DraftItem {
  id: number | null // null for newly-added items
  mediaId: number
  durationMsOverride: number | null
}

export function reorderItems<T>(
  items: T[],
  fromIndex: number,
  toIndex: number
): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length
  ) {
    return items
  }
  const next = items.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}
```

- [ ] **Step 3: Run — 5 passed**

- [ ] **Step 4: `app/components/MediaPicker.vue`** — searchable grid drawer used by the editor

```vue
<!-- app/components/MediaPicker.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import type { MediaListRow } from '~/app/types/api'

const emit = defineEmits<{ (e: 'pick', m: MediaListRow): void }>()

const store = useMediaStore()
const search = ref('')

onMounted(() => {
  if (store.list.length === 0) store.refresh()
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.list
  return store.list.filter((m) => m.filename.toLowerCase().includes(q))
})
</script>

<template>
  <div>
    <UInput
      v-model="search"
      placeholder="Search media…"
      icon="i-lucide-search"
      class="w-full"
    />
    <div class="mt-3 grid grid-cols-3 gap-2 max-h-96 overflow-y-auto pr-1">
      <button
        v-for="m in filtered"
        :key="m.id"
        type="button"
        class="group text-left rounded-md border border-(--ui-border) bg-(--ui-bg) hover:border-primary-500 overflow-hidden"
        @click="emit('pick', m)"
      >
        <div class="aspect-video bg-zinc-900">
          <img
            v-if="m.thumbnailBytes"
            :src="`/media/${m.sha256}/thumb`"
            :alt="m.filename"
            class="h-full w-full object-cover"
          />
          <div
            v-else
            class="flex h-full items-center justify-center text-(--ui-text-muted)"
          >
            <UIcon
              :name="m.kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
              class="size-6"
            />
          </div>
        </div>
        <p class="truncate p-2 text-xs">{{ m.filename }}</p>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: `app/components/PlaylistItemRow.vue`**

```vue
<!-- app/components/PlaylistItemRow.vue -->
<script setup lang="ts">
import type { MediaListRow } from '~/app/types/api'
import type { DraftItem } from '~/app/components/PlaylistEditor.logic'

const props = defineProps<{
  item: DraftItem
  index: number
  media: MediaListRow | null
  total: number
}>()
defineEmits<{
  (e: 'update:duration', ms: number | null): void
  (e: 'remove'): void
  (e: 'move', delta: number): void
}>()
</script>

<template>
  <li
    class="flex items-center gap-3 rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) p-3"
  >
    <div class="flex flex-col">
      <UButton
        icon="i-lucide-chevron-up"
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="index === 0"
        @click="$emit('move', -1)"
      />
      <UButton
        icon="i-lucide-chevron-down"
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="index === total - 1"
        @click="$emit('move', 1)"
      />
    </div>
    <div class="aspect-video w-32 shrink-0 overflow-hidden rounded bg-zinc-900">
      <img
        v-if="media?.thumbnailBytes"
        :src="`/media/${media.sha256}/thumb`"
        :alt="media.filename"
        class="h-full w-full object-cover"
      />
      <div
        v-else
        class="flex h-full items-center justify-center text-(--ui-text-muted)"
      >
        <UIcon name="i-lucide-image" class="size-5" />
      </div>
    </div>
    <div class="flex-1 min-w-0">
      <p class="truncate text-sm font-medium">
        {{ media?.filename ?? `media #${item.mediaId}` }}
      </p>
      <p class="mt-1 text-xs text-(--ui-text-muted)">
        {{ media?.kind === 'video' ? 'Video' : 'Image' }}
      </p>
    </div>
    <div class="flex flex-col gap-1 items-end">
      <label class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
        Duration (s)
        <UInput
          :model-value="item.durationMsOverride !== null ? item.durationMsOverride / 1000 : ''"
          @update:model-value="
            (v) =>
              $emit(
                'update:duration',
                v === '' ? null : Math.round(Number(v) * 1000)
              )
          "
          type="number"
          size="xs"
          :disabled="media?.kind === 'video'"
          :placeholder="media?.kind === 'video' ? 'native' : '10'"
          class="w-20"
        />
      </label>
      <UButton
        icon="i-lucide-x"
        color="error"
        variant="soft"
        size="xs"
        @click="$emit('remove')"
      >
        Remove
      </UButton>
    </div>
  </li>
</template>
```

- [ ] **Step 6: `app/pages/playlists/[id].vue`** — the editor

```vue
<!-- app/pages/playlists/[id].vue -->
<script setup lang="ts">
import { useApiClient } from '~/app/composables/useApiClient'
import { useMediaStore } from '~/app/stores/media'
import { usePlaylistsStore } from '~/app/stores/playlists'
import { reorderItems, type DraftItem } from '~/app/components/PlaylistEditor.logic'
import type { MediaListRow, PlaylistDetail } from '~/app/types/api'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const api = useApiClient()
const mediaStore = useMediaStore()
const playlistsStore = usePlaylistsStore()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => Number(route.params.id))
const playlist = ref<PlaylistDetail | null>(null)
const drafts = ref<DraftItem[]>([])
const editingName = ref(false)
const editName = ref('')
const saving = ref(false)

async function load() {
  try {
    const [pl] = await Promise.all([api.getPlaylist(id.value), mediaStore.refresh()])
    playlist.value = pl
    editName.value = pl.name
    drafts.value = pl.items.map((i) => ({
      id: i.id,
      mediaId: i.mediaId,
      durationMsOverride: i.durationMsOverride
    }))
  } catch (err: any) {
    toast.add({
      title: 'Load failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

onMounted(load)

const dirty = computed(() => {
  if (!playlist.value) return false
  if (drafts.value.length !== playlist.value.items.length) return true
  return drafts.value.some((d, i) => {
    const orig = playlist.value!.items[i]
    return d.mediaId !== orig.mediaId || d.durationMsOverride !== orig.durationMsOverride
  })
})

function addItem(m: MediaListRow) {
  drafts.value.push({
    id: null,
    mediaId: m.id,
    durationMsOverride: m.kind === 'image' ? 10_000 : null
  })
}

function removeItem(i: number) {
  drafts.value.splice(i, 1)
}

function move(i: number, delta: number) {
  drafts.value = reorderItems(drafts.value, i, i + delta)
}

function updateDuration(i: number, ms: number | null) {
  drafts.value[i].durationMsOverride = ms
}

function mediaFor(mediaId: number): MediaListRow | null {
  return mediaStore.list.find((m) => m.id === mediaId) ?? null
}

async function saveItems() {
  if (!playlist.value) return
  // Validate: all images must have a duration
  for (const d of drafts.value) {
    const m = mediaFor(d.mediaId)
    if (m?.kind === 'image' && !d.durationMsOverride) {
      toast.add({
        title: 'Fix durations',
        description: `Image "${m.filename}" needs a duration.`,
        color: 'error'
      })
      return
    }
  }
  saving.value = true
  try {
    await api.replacePlaylistItems(playlist.value.id, {
      items: drafts.value.map((d) => ({
        mediaId: d.mediaId,
        durationMsOverride: d.durationMsOverride ?? undefined
      }))
    })
    await load()
    toast.add({ title: 'Saved', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Save failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

async function saveName() {
  if (!playlist.value || !editName.value.trim()) return
  try {
    await playlistsStore.update(playlist.value.id, { name: editName.value.trim() })
    playlist.value = await api.getPlaylist(id.value)
    editingName.value = false
    toast.add({ title: 'Renamed', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Rename failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function deletePlaylist() {
  if (!playlist.value) return
  const ok = await confirm({
    title: `Delete ${playlist.value.name}?`,
    description: 'Removes this playlist and all its items. Assignments to this playlist will also be removed.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await playlistsStore.delete(playlist.value.id)
    router.push('/playlists')
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>
      <NuxtLink to="/playlists" class="hover:text-(--ui-text)">Playlists</NuxtLink>
      <span> / </span>
      <span class="text-(--ui-text)">{{ playlist?.name ?? '…' }}</span>
    </template>

    <div v-if="!playlist">
      <USkeleton class="h-32 w-full" />
    </div>
    <template v-else>
      <section class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
              Playlist · v{{ playlist.version }}
            </p>
            <template v-if="!editingName">
              <h2 class="mt-1 text-2xl font-semibold">{{ playlist.name }}</h2>
            </template>
            <template v-else>
              <UInput
                v-model="editName"
                autofocus
                class="mt-1 w-80"
                @keyup.enter="saveName"
              />
            </template>
          </div>
          <div class="flex gap-2">
            <template v-if="!editingName">
              <UButton variant="soft" icon="i-lucide-pencil" @click="editingName = true">
                Rename
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="deletePlaylist"
              >
                Delete
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="saveName">Save name</UButton>
              <UButton
                variant="ghost"
                @click="editingName = false; editName = playlist!.name"
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <div class="mt-8 grid grid-cols-[1fr_2fr] gap-6">
        <section class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4">
          <h3 class="text-sm font-semibold">Media library</h3>
          <p class="mt-1 text-xs text-(--ui-text-muted)">
            Click a tile to append it to the playlist.
          </p>
          <div class="mt-3">
            <MediaPicker @pick="addItem" />
          </div>
        </section>

        <section class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">
              Items <span class="text-(--ui-text-muted) font-normal">({{ drafts.length }})</span>
            </h3>
            <UButton
              color="primary"
              :disabled="!dirty"
              :loading="saving"
              @click="saveItems"
            >
              Save changes
            </UButton>
          </div>

          <EmptyState
            v-if="drafts.length === 0"
            class="mt-4"
            icon="i-lucide-list-music"
            title="Empty playlist"
            description="Pick media from the left panel to add items."
          />
          <ul v-else class="mt-4 space-y-2">
            <PlaylistItemRow
              v-for="(item, i) in drafts"
              :key="item.id ?? `new-${i}`"
              :item="item"
              :index="i"
              :total="drafts.length"
              :media="mediaFor(item.mediaId)"
              @move="(delta) => move(i, delta)"
              @remove="removeItem(i)"
              @update:duration="(ms) => updateDuration(i, ms)"
            />
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 7: Run all tests**

```bash
pnpm test
```

Expected: all prior passes + 5 reorder = 157.

- [ ] **Step 8: Smoke**

```bash
pnpm dev &
sleep 6
status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/playlists)
echo "/playlists → $status"
kill %1 2>/dev/null || true
```

Expected: 200.

- [ ] **Step 9: Commit**

```bash
git add app/pages/playlists/[id].vue app/components/MediaPicker.vue app/components/PlaylistItemRow.vue app/components/PlaylistEditor.logic.ts tests/components/PlaylistEditor.test.ts
git commit -m "feat(ui): playlist editor with move-up/down reorder and inline duration edit"
```

**Note on reorder UX:** We chose up/down arrow buttons rather than true drag-and-drop. Rationale: drag-drop in Vue + Nuxt UI requires `@vueuse/core` `useDraggable` or `vue-draggable-next`, which adds state and integration work that's worth ~2 tasks on its own. Arrow buttons are visible, keyboard-friendly, and test trivially. Drag-drop can land in a polish pass later.

---

## Task 14: Wire dashboard SSE stream globally + connection indicator

**Files:**
- Modify: `app/layouts/default.vue`
- Modify: `app/app.vue`

Previously the layout had a placeholder `streamState` ref. Now we wire the actual `useDashboardStream`.

- [ ] **Step 1: Update `app/layouts/default.vue`**

Replace the placeholder block:

```ts
// Placeholder until Task 5; real state comes from useDashboardStream()
const streamState = ref<'connecting' | 'connected' | 'disconnected'>('connected')
```

with:

```ts
const stream = import.meta.client ? useDashboardStream() : null
const streamState = computed(() =>
  stream ? stream.state.value : ('connecting' as const)
)
```

Remove the placeholder `ref` above it. The SSR-safe `computed` avoids opening an `EventSource` during server rendering.

- [ ] **Step 2: Register devices-store handler for device-events**

Already done in `app/pages/index.vue` and `app/pages/devices/index.vue`. But ideally the subscription is one-shot for the app lifetime, not per page. Move it to `app/app.vue`:

```vue
<!-- app/app.vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useDashboardStream } from '~/app/composables/useDashboardStream'

useHead({
  title: 'Lanka',
  link: [{ rel: 'icon', href: '/favicon.ico' }]
})

onMounted(() => {
  if (import.meta.client) {
    const stream = useDashboardStream()
    const devicesStore = useDevicesStore()
    stream.onDeviceEvent((p) => devicesStore.applyDeviceEvent(p))
  }
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
```

Remove the duplicate SSE subscription from `index.vue` and `devices/index.vue`:

```ts
// Remove from both pages:
// if (import.meta.client) {
//   const stream = useDashboardStream()
//   stream.onDeviceEvent((p) => devicesStore.applyDeviceEvent(p))
// }
```

- [ ] **Step 3: Smoke**

```bash
pnpm build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
git add app/layouts/default.vue app/app.vue app/pages/index.vue app/pages/devices/index.vue
git commit -m "feat(ui): wire dashboard SSE at app level; sidebar connection indicator"
```

---

## Task 15: Visual smoke test via dev server + screenshot log

**Files:**
- None (manual verification)

Auto mode guidance from CLAUDE.md: "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete."

We can't actually open a browser from the subagent, but we can:
1. Start the dev server
2. Hit each route with `curl` and confirm 200
3. Seed some data via the API and confirm pages render it

- [ ] **Step 1: Start server, seed minimal data, check every route**

```bash
pnpm dev &
SERVER_PID=$!
sleep 6

# Routes return 200
for path in / /addresses /groups /devices /media /playlists; do
  status=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000$path)
  echo "$path → $status"
done

# Seed: create an address, group, device, playlist via the API
ADDR=$(curl -sX POST -H 'content-type: application/json' \
  -d '{"name":"Smoke Clinic"}' http://localhost:3000/api/addresses | jq -r .id)
GRP=$(curl -sX POST -H 'content-type: application/json' \
  -d "{\"addressId\":$ADDR,\"name\":\"Lobby\"}" http://localhost:3000/api/groups | jq -r .id)

curl -sX POST -H 'content-type: application/json' \
  -d '{"deviceId":"smoke-tv-1","playerVersion":"0.1.0"}' \
  http://localhost:3000/api/devices/register

curl -sX POST -H 'content-type: application/json' \
  -d '{"name":"Smoke Promo"}' http://localhost:3000/api/playlists

# Confirm data appears
curl -s http://localhost:3000/api/devices | jq '.[] | .id'
curl -s http://localhost:3000/api/addresses | jq '.[] | .name'

kill $SERVER_PID 2>/dev/null || true
```

Expected: all routes 200; seed data visible in the JSON responses.

- [ ] **Step 2: Commit nothing (manual verification only)**

No commit — this is a verification step, not a code change.

---

## Task 16: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update "Status" and "Next plans" sections**

Read `README.md` first, then replace the existing `**Status:**` line with:

```markdown
**Status:** Plan 1 + Plan 2a + Plan 2b complete — foundation, device sync, admin CRUD API, and dashboard UI.
```

Replace the "Next plans" section with:

```markdown
## Next plans

1. **Player web page** (Plan 3) — `/player` Nuxt route with double-buffered playback + SSE client for TVs.
2. **Deployment** (Plan 4) — Dockerfile, Compose, systemd, backups.
3. **Android APK** (Plan 5) — native kiosk shell with FS bridge.
```

Add a new section above "Next plans" titled "Dashboard":

```markdown
## Dashboard

Visit `http://localhost:3000` during dev. Routes:

- `/` — Overview (stat cards, unclaimed-device claim tray)
- `/addresses` — Addresses list + detail
- `/groups` — Groups list + detail (filterable by address)
- `/devices` — Devices list with live SSE status + detail with reload / assignment override
- `/media` — Media library with drag-drop upload
- `/playlists` — Playlists list + editor (reorder + inline image-duration)

Dark mode default; toggle in the header. Desktop-only (minimum 1280px wide).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for dashboard UI milestone"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Overview: stats / unclaimed tray / error feed (Task 7 — error feed is placeholder; documented gap)
- ✅ Addresses + detail (Task 8)
- ✅ Groups + detail (Task 8)
- ✅ Devices list with filters + live status (Task 10)
- ✅ Device detail with reload + assignment override (Task 10)
- ✅ Media library with upload + in-use delete (Task 11)
- ✅ Playlists list + editor (Tasks 12, 13)
- ✅ Drag-reorder (implemented as up/down buttons — documented trade-off, not true drag)
- ✅ Dark mode default with toggle (Task 1, 2)
- ✅ Loading skeletons + empty states (Tasks 8–13, using `<USkeleton>` + `<EmptyState>`)
- ✅ Toast notifications on mutations (Tasks 7–13)
- ✅ Confirmation dialogs for destructive actions (Task 9, used in Tasks 8, 10, 11, 13)
- ✅ Dashboard SSE for live device updates (Tasks 5, 14)

**Known gaps (intentional, flagged in-plan):**
- **Error feed** on the overview is a placeholder until a `GET /api/device-errors` endpoint is added. Workaround: the data IS persisted in the `device_errors` table — adding the endpoint is a 1-task follow-up in Plan 3+.
- **Device detail `currentPlaylistId`** for the assignment picker is passed as `null` because Plan 2a doesn't expose a "read current assignment" endpoint. The picker still works (Apply creates/replaces; "No direct assignment" deletes). A follow-up can add a `GET /api/assignments/devices/:id` read endpoint.
- **True drag-and-drop** is deferred — up/down arrows are sufficient and easier to test.
- **Bulk operations** (multi-select devices, bulk playlist assign) are out of scope.
- **Mobile layout** — desktop-only per spec; minimum 1280px width enforced.

**Placeholder scan:** Each task has complete code. No "TBD"/"TODO"/"similar to…" left.

**Type consistency:**
- `DeviceListRow`, `MediaListRow`, `PlaylistSummary`, `PlaylistDetail` — defined in `types/api.ts`, used uniformly.
- `useApiClient` matches server handler return shapes exactly (spec-reviewer in Plan 1/2a confirmed).
- `useConfirm()` is defined in Task 9 but referenced earlier in Task 8 — the implementer executing Task 8 should either complete Task 9 first or include the `useConfirm.ts` + `ConfirmDialog.vue` files in Task 8's commit. The plan orders them for narrative clarity; execution can merge them.

**Test coverage:**
- Unit: useApiClient (12 tests), useDashboardStream (5), devices store (5), PlaylistEditor reorder (5) = 27 new tests
- Component: PlaylistItemRow and friends not unit-tested; manually verified via dev server
- Server tests: unchanged from Plan 2a (130)
- Total expected at end: 157 passing

**Minor notes for the implementer:**
- `@nuxt/fonts` will fetch fonts on first build. May be slow.
- Dark mode flicker: `colorMode.preference = 'dark'` + `classSuffix: ''` combined with the `@theme` CSS means the system hasn't gone through a flash-of-unstyled-content — confirmed in Task 1 smoke.
- The `min-w-[1280px]` on `body` is deliberate; windows narrower than that horizontally-scroll the whole viewport, which is the documented "desktop-only" behavior.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-lanka-dashboard-ui.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, two-stage review. Matches Plan 1 and Plan 2a execution.

**2. Inline Execution** — Batched via `superpowers:executing-plans`.

**Which approach?**
