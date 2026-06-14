# Dashboard now-playing, media detail/edit, play counts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface what each device is currently playing, give media a detail/edit drawer (metadata, usage, organization assignment), and count plays per media — visible to admins (drawer) and the owning client (portal), no billing.

**Architecture:** Reuse the existing event-driven telemetry (`itemStarted` → POST `{currentItemId}`) to increment a new `media.play_count` column. Add a thin `GET /api/devices/:id/status` for now-playing, enrich the media list/detail endpoints, and extend the existing portal reach stats. UI: a now-playing card on the device page, a media slide-over drawer, and a "Plays" column in the portal — all poll every 5s.

**Tech Stack:** Nuxt 4 (SPA), Nitro, Drizzle ORM (better-sqlite3), Nuxt UI v3, Vitest, vue-i18n.

**Spec:** `docs/superpowers/specs/2026-06-14-dashboard-now-playing-media-detail-play-counts-design.md`

---

## File Structure

**Backend**
- `server/db/schema.ts` (modify) — add `playCount` to `media`.
- `server/api/devices/[id]/telemetry.post.ts` (modify) — increment play_count on a real start.
- `server/api/devices/[id]/status.get.ts` (create) — now-playing status.
- `server/api/media/index.get.ts` (modify) — return `organizationId` + `playCount`.
- `server/api/media/[id].get.ts` (modify) — enrich with playlists-used + `organizationId` + `playCount`.
- `server/services/reach.ts` (modify) — add `playCount` to each media row of `OrgReach`.

**Frontend**
- `app/types/api.ts` (modify) — `DeviceStatus`, `MediaDetail`; add `organizationId`/`playCount` to media types + `OrgReach.media`.
- `app/composables/useApiClient.ts` (modify) — `getDeviceStatus`, `getMediaDetail`, `setMediaOrganization`, `listOrganizations`.
- `app/pages/devices/[id].vue` (modify) — now-playing card + 5s poll.
- `app/components/NowPlayingCard.vue` (create) — presentational.
- `app/pages/media.vue` (modify) — open drawer on card click.
- `app/components/MediaCard.vue` (modify) — emit `select`, show org/plays badges.
- `app/components/MediaDetailDrawer.vue` (create) — metadata, usage, org dropdown, play count (polls).
- `app/pages/portal/index.vue` (modify) — "Plays" column.

**i18n**
- `i18n/locales/en.json`, `i18n/locales/uk.json` (modify) — new keys.

**Tests**
- `tests/api/devices-telemetry.test.ts` (modify) — counting rule.
- `tests/api/devices-status.test.ts` (create).
- `tests/api/media-detail.test.ts` (create).

---

## Task 1: Add `media.play_count` column

**Files:**
- Modify: `server/db/schema.ts` (the `media` table)
- Generated: `server/db/migrations/*` (via drizzle-kit)

- [ ] **Step 1: Add the column** to the `media` table definition (place after `thumbnailBytes`):

```ts
playCount: integer('play_count').notNull().default(0),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new migration file under `server/db/migrations/` adding `play_count`.

- [ ] **Step 3: Apply it to the dev DB**

Run: `pnpm db:migrate`
Expected: no error; `sqlite3 data/signage.db ".schema media"` shows `play_count`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.ts server/db/migrations
git commit -m "feat(db): add media.play_count column"
```

---

## Task 2: Count plays in telemetry (TDD)

**Files:**
- Modify: `server/api/devices/[id]/telemetry.post.ts`
- Test: `tests/api/devices-telemetry.test.ts`

- [ ] **Step 1: Add failing tests** (append inside the existing `describe`, reusing its `setup()`):

```ts
it('increments media.play_count on a real item start', async () => {
  const { item } = await setup()
  await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
  expect(m.playCount).toBe(1)
  await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
  const [m2] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
  expect(m2.playCount).toBe(2)
})

it('does NOT count a failed item (error present)', async () => {
  const { item } = await setup()
  await handleTelemetry(db, 'dev-1', { currentItemId: item.id, error: { message: 'decode failed' } })
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
  expect(m.playCount).toBe(0)
})

it('does NOT count a clear (currentItemId null)', async () => {
  const { item } = await setup()
  await handleTelemetry(db, 'dev-1', { currentItemId: null })
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, item.mediaId))
  expect(m.playCount).toBe(0)
})
```

- [ ] **Step 2: Run, verify they fail**

Run: `pnpm test -- devices-telemetry`
Expected: the three new tests FAIL (play_count stays 0 / undefined).

- [ ] **Step 3: Implement the increment.** In `handleTelemetry`, the code already looks up the playlist item when `currentItemId !== null`. Add the `sql` import and increment there:

Add to the drizzle import at top:
```ts
import { eq, sql } from 'drizzle-orm'
```

Replace the existing `if (body.currentItemId !== null) { ...lookup... }` block with:
```ts
if (body.currentItemId !== null) {
  const [item] = await db
    .select()
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.id, body.currentItemId))
  if (!item) {
    throw createError({
      statusCode: 400,
      message: `Unknown playlist item: ${body.currentItemId}`
    })
  }
  // A non-null currentItemId without an error is a real play start → count it.
  if (!body.error) {
    await db
      .update(schema.media)
      .set({ playCount: sql`${schema.media.playCount} + 1` })
      .where(eq(schema.media.id, item.mediaId))
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- devices-telemetry`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/\[id\]/telemetry.post.ts tests/api/devices-telemetry.test.ts
git commit -m "feat(telemetry): count plays into media.play_count on item start"
```

---

## Task 3: `GET /api/devices/:id/status` (TDD)

**Files:**
- Create: `server/api/devices/[id]/status.get.ts`
- Test: `tests/api/devices-status.test.ts`

- [ ] **Step 1: Write failing test** `tests/api/devices-status.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { assign, seedAddress, seedDevice, seedGroup, seedMedia, seedPlaylist } from '../helpers/fixtures'
import { handleDeviceStatus } from '~/server/api/devices/[id]/status.get'
import { handleTelemetry } from '~/server/api/devices/[id]/telemetry.post'
import * as schema from '~/server/db/schema'

describe('GET /api/devices/:id/status handler', () => {
  let db: TestDb, close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  async function setup() {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const m = await seedMedia(db, { sha256: 'sha-1', kind: 'video', filename: 'clip.mp4' })
    const pl = await seedPlaylist(db, { name: 'Lobby', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })
    const [item] = await db.select().from(schema.playlistItems).where(eq(schema.playlistItems.playlistId, pl.id))
    return { item, media: m }
  }

  it('reports current item + playlist after a telemetry start', async () => {
    const { item, media } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.online).toBe(true)
    expect(s.currentItem?.mediaId).toBe(media.id)
    expect(s.currentItem?.filename).toBe('clip.mp4')
    expect(s.playlistName).toBe('Lobby')
  })

  it('currentItem is null when nothing is playing', async () => {
    await setup()
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.currentItem).toBeNull()
  })

  it('online is false when last seen is stale', async () => {
    await setup()
    await db.update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.devices.id, 'dev-1'))
    const s = await handleDeviceStatus(db, 'dev-1')
    expect(s.online).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- devices-status`
Expected: FAIL (module not found / handler undefined).

- [ ] **Step 3: Implement** `server/api/devices/[id]/status.get.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const ONLINE_WINDOW_MS = 90_000

export type DeviceStatus = {
  online: boolean
  lastSeenAt: number | null
  currentItem: { mediaId: number; filename: string; kind: 'video' | 'image'; sha256: string } | null
  playlistName: string | null
}

export async function handleDeviceStatus(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<DeviceStatus> {
  const [device] = await db.select().from(schema.devices).where(eq(schema.devices.id, deviceId))
  if (!device) throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })

  const lastSeenAt = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null
  const online = lastSeenAt !== null && Date.now() - lastSeenAt < ONLINE_WINDOW_MS

  let currentItem: DeviceStatus['currentItem'] = null
  let playlistName: string | null = null
  if (device.currentItemId !== null) {
    const [row] = await db
      .select({
        mediaId: schema.media.id,
        filename: schema.media.filename,
        kind: schema.media.kind,
        sha256: schema.media.sha256,
        playlistName: schema.playlists.name
      })
      .from(schema.playlistItems)
      .innerJoin(schema.media, eq(schema.media.id, schema.playlistItems.mediaId))
      .innerJoin(schema.playlists, eq(schema.playlists.id, schema.playlistItems.playlistId))
      .where(eq(schema.playlistItems.id, device.currentItemId))
    if (row) {
      currentItem = { mediaId: row.mediaId, filename: row.filename, kind: row.kind as 'video' | 'image', sha256: row.sha256 }
      playlistName = row.playlistName
    }
  }
  return { online, lastSeenAt, currentItem, playlistName }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  return handleDeviceStatus(useDb(), id)
})
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- devices-status`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/\[id\]/status.get.ts tests/api/devices-status.test.ts
git commit -m "feat(api): add device status endpoint (now-playing + online)"
```

---

## Task 4: Enrich media list + detail endpoints (TDD)

**Files:**
- Modify: `server/api/media/index.get.ts`, `server/api/media/[id].get.ts`
- Test: `tests/api/media-detail.test.ts`

- [ ] **Step 1: Failing test** `tests/api/media-detail.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { handleListMedia } from '~/server/api/media/index.get'
import { handleGetMedia } from '~/server/api/media/[id].get'
import * as schema from '~/server/db/schema'

describe('media list + detail enrichment', () => {
  let db: TestDb, close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('list returns organizationId and playCount', async () => {
    const [org] = await db.insert(schema.organizations).values({ name: 'Acme' }).returning()
    const m = await seedMedia(db, { sha256: 's1', kind: 'image', filename: 'a.jpg' })
    await db.update(schema.media).set({ organizationId: org.id, playCount: 3 }).where(eq(schema.media.id, m.id))
    const rows = await handleListMedia(db)
    const row = rows.find((r) => r.id === m.id)!
    expect(row.organizationId).toBe(org.id)
    expect(row.playCount).toBe(3)
  })

  it('detail returns playlists-used, organizationId, playCount', async () => {
    const m = await seedMedia(db, { sha256: 's2', kind: 'video', filename: 'b.mp4' })
    const pl = await seedPlaylist(db, { name: 'P1', items: [{ mediaId: m.id }] })
    const detail = await handleGetMedia(db, m.id)
    expect(detail.playCount).toBe(0)
    expect(detail.organizationId).toBeNull()
    expect(detail.playlists).toEqual([{ id: pl.id, name: 'P1' }])
  })
})
```
(add `import { eq } from 'drizzle-orm'` at top.)

- [ ] **Step 2: Run, verify fail** — `pnpm test -- media-detail` → FAIL.

- [ ] **Step 3: Update list** — in `server/api/media/index.get.ts`, add to the `.select({...})`:

```ts
      organizationId: schema.media.organizationId,
      playCount: schema.media.playCount,
```
and update `MediaListRow` (it's `typeof schema.media.$inferSelect & { usedInPlaylists: number }`, which already includes the new columns — no type change needed beyond the select).

- [ ] **Step 4: Rewrite detail** `server/api/media/[id].get.ts` to return playlists-used + org + playCount:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export type MediaDetail = typeof schema.media.$inferSelect & {
  playlists: { id: number; name: string }[]
}

export async function handleGetMedia(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<MediaDetail> {
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, id))
  if (!m) throw createError({ statusCode: 404, message: 'Media not found' })
  const playlists = await db
    .selectDistinct({ id: schema.playlists.id, name: schema.playlists.name })
    .from(schema.playlistItems)
    .innerJoin(schema.playlists, eq(schema.playlists.id, schema.playlistItems.playlistId))
    .where(eq(schema.playlistItems.mediaId, id))
  return { ...m, playlists }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad media id' })
  return handleGetMedia(useDb(), id)
})
```
(If the existing file exports a differently-named handler used elsewhere, keep the old export name as an alias.)

- [ ] **Step 5: Run, verify pass** — `pnpm test -- media-detail` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/api/media tests/api/media-detail.test.ts
git commit -m "feat(api): media list+detail expose organization and playCount"
```

---

## Task 5: Portal reach — add playCount (TDD)

**Files:**
- Modify: `server/services/reach.ts` (the `OrgReach` type + `computeOrgReach` media aggregation)
- Test: extend the existing reach test if present, else add `tests/api/portal-stats.test.ts`

- [ ] **Step 1:** Read `server/services/reach.ts`. Add `playCount: number` to the `OrgReach['media'][number]` type, and include `playCount: schema.media.playCount` in the media select/aggregation (group by media id; it's a plain column so no aggregate needed).

- [ ] **Step 2: Test** — assert a media with `playCount` set surfaces it in `computeOrgReach(db, orgId).media[*].playCount`. (Mirror the setup in any existing reach test; seed media with `organizationId` = the org and a `playCount`, plus an assignment so it appears.)

- [ ] **Step 3:** Run `pnpm test -- reach` (or `portal-stats`) → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/reach.ts tests/api
git commit -m "feat(portal): include playCount in org reach stats"
```

---

## Task 6: API client + shared types

**Files:**
- Modify: `app/types/api.ts`, `app/composables/useApiClient.ts`

- [ ] **Step 1: Types** in `app/types/api.ts`:
  - Add `organizationId: number | null` and `playCount: number` to the media list row type and any `MediaListRow`/`Media` interface used by the media page.
  - Add `playCount: number` to the `OrgReach.media[]` item interface (line ~157 region).
  - Add:
    ```ts
    export interface DeviceStatus {
      online: boolean
      lastSeenAt: number | null
      currentItem: { mediaId: number; filename: string; kind: 'video' | 'image'; sha256: string } | null
      playlistName: string | null
    }
    export interface MediaDetail extends MediaListRow {
      playlists: { id: number; name: string }[]
    }
    ```

- [ ] **Step 2: Client methods** in `app/composables/useApiClient.ts` (add to the interface + the returned object):
```ts
// interface
getDeviceStatus(id: string): Promise<DeviceStatus>
getMediaDetail(id: number): Promise<MediaDetail>
setMediaOrganization(id: number, organizationId: number | null): Promise<void>
listOrganizations(): Promise<Organization[]>
// implementation
getDeviceStatus: (id) => fetch<DeviceStatus>(`/api/devices/${id}/status`, { method: 'GET' }),
getMediaDetail: (id) => fetch<MediaDetail>(`/api/media/${id}`, { method: 'GET' }),
setMediaOrganization: (id, organizationId) =>
  fetch<void>(`/api/media/${id}/organization`, { method: 'PUT', body: { organizationId } }),
listOrganizations: () => fetch<Organization[]>('/api/organizations', { method: 'GET' }),
```
(Import `DeviceStatus`, `MediaDetail`, `Organization` types; reuse the existing `Organization` type if defined, else add one `{ id: number; name: string }`.)

- [ ] **Step 3: Typecheck the touched files build** — Run `pnpm build` (gate per project conventions; typecheck is not a gate). Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/types/api.ts app/composables/useApiClient.ts
git commit -m "feat(api-client): device status, media detail, org assignment, orgs list"
```

---

## Task 7: Device now-playing UI

**Files:**
- Create: `app/components/NowPlayingCard.vue`
- Modify: `app/pages/devices/[id].vue`

- [ ] **Step 1: Component** `app/components/NowPlayingCard.vue`:
```vue
<script setup lang="ts">
import type { DeviceStatus } from '~/app/types/api'
const props = defineProps<{ status: DeviceStatus | null }>()
const thumb = computed(() =>
  props.status?.currentItem ? `/media/${props.status.currentItem.sha256}/thumb` : null
)
</script>

<template>
  <div class="soft-card p-5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-(--ui-text-highlighted)">{{ $t('devices.nowPlaying') }}</h3>
      <span
        class="rounded-full px-2 py-0.5 text-xs"
        :class="status?.online ? 'bg-emerald-500/15 text-emerald-600' : 'bg-(--ui-bg-accented) text-(--ui-text-muted)'"
      >{{ status?.online ? $t('devices.online') : $t('devices.offline') }}</span>
    </div>
    <div v-if="status?.currentItem" class="mt-4 flex items-center gap-3">
      <img v-if="thumb" :src="thumb" class="h-16 w-28 rounded object-cover bg-black" alt="" />
      <div>
        <p class="font-medium text-(--ui-text-highlighted)">{{ status.currentItem.filename }}</p>
        <p class="text-sm text-(--ui-text-muted)">
          {{ status.currentItem.kind === 'video' ? $t('components.playlistItemRow.video') : $t('components.playlistItemRow.image') }}
          · {{ status.playlistName }}
        </p>
      </div>
    </div>
    <p v-else class="mt-4 text-sm text-(--ui-text-muted)">{{ $t('devices.nothingPlaying') }}</p>
  </div>
</template>
```

- [ ] **Step 2: Wire into the page.** In `app/pages/devices/[id].vue` `<script setup>`, add a poll and render the card near the top of the device detail layout:
```ts
const status = ref<DeviceStatus | null>(null)
let statusTimer: ReturnType<typeof setInterval> | null = null
async function refreshStatus() {
  try { status.value = await api.getDeviceStatus(deviceId) } catch { /* keep last */ }
}
onMounted(() => { refreshStatus(); statusTimer = setInterval(refreshStatus, 5000) })
onBeforeUnmount(() => { if (statusTimer) clearInterval(statusTimer) })
```
(Use the page's existing `api` client and `deviceId`/route param; if named differently, match them.) Add `<NowPlayingCard :status="status" />` in the template.

- [ ] **Step 3: Verify in browser/box** — open the device page while the box plays; the card shows the video + "online", filename matches. (Manual; covered fully in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add app/components/NowPlayingCard.vue app/pages/devices/\[id\].vue
git commit -m "feat(devices): now-playing card with 5s poll"
```

---

## Task 8: Media detail drawer + org assignment

**Files:**
- Create: `app/components/MediaDetailDrawer.vue`
- Modify: `app/components/MediaCard.vue`, `app/pages/media.vue`

- [ ] **Step 1: MediaCard emits select.** In `app/components/MediaCard.vue`, add `const emit = defineEmits<{ select: [], delete: [] }>()` (keep existing `delete`), make the card clickable (`@click="emit('select')"`), and add small badges: play count and org name when present (`props.media.playCount`, `props.media.organizationId`).

- [ ] **Step 2: Drawer** `app/components/MediaDetailDrawer.vue`:
```vue
<script setup lang="ts">
import type { MediaDetail, Organization } from '~/app/types/api'
const props = defineProps<{ mediaId: number | null }>()
const emit = defineEmits<{ 'update:open': [boolean], changed: [] }>()
const api = useApiClient()
const { t } = useI18n()
const toast = useToast()

const detail = ref<MediaDetail | null>(null)
const orgs = ref<Organization[]>([])
const open = computed({ get: () => props.mediaId !== null, set: (v) => { if (!v) emit('update:open', false) } })
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  if (props.mediaId === null) return
  detail.value = await api.getMediaDetail(props.mediaId)
}
function humanBytes(n: number) {
  const u = ['B','KB','MB','GB']; let i = 0; let b = n
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`
}
async function assignOrg(organizationId: number | null) {
  if (!detail.value) return
  try {
    await api.setMediaOrganization(detail.value.id, organizationId)
    detail.value.organizationId = organizationId
    emit('changed')
    toast.add({ title: t('media.orgUpdated'), color: 'success' })
  } catch (e: any) {
    toast.add({ title: t('media.orgUpdateFailed'), description: e?.data?.message ?? e?.message, color: 'error' })
  }
}
watch(() => props.mediaId, async (id) => {
  if (timer) { clearInterval(timer); timer = null }
  if (id !== null) {
    await load()
    if (orgs.value.length === 0) orgs.value = await api.listOrganizations()
    timer = setInterval(load, 5000) // play count ticks up live
  }
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <USlideover v-model:open="open" :title="detail?.filename ?? $t('media.details')">
    <template #body>
      <div v-if="detail" class="space-y-6">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt class="text-(--ui-text-muted)">{{ $t('media.plays') }}</dt>
          <dd class="tabular-nums font-medium">{{ detail.playCount }}</dd>
          <dt class="text-(--ui-text-muted)">{{ $t('media.type') }}</dt><dd>{{ detail.mimeType }}</dd>
          <dt class="text-(--ui-text-muted)">{{ $t('media.size') }}</dt><dd>{{ humanBytes(detail.bytes) }}</dd>
          <template v-if="detail.width">
            <dt class="text-(--ui-text-muted)">{{ $t('media.dimensions') }}</dt><dd>{{ detail.width }}×{{ detail.height }}</dd>
          </template>
          <template v-if="detail.durationMs">
            <dt class="text-(--ui-text-muted)">{{ $t('media.duration') }}</dt><dd>{{ Math.round(detail.durationMs/1000) }}s</dd>
          </template>
          <dt class="text-(--ui-text-muted)">{{ $t('media.uploaded') }}</dt>
          <dd>{{ new Date(detail.createdAt).toLocaleString() }}</dd>
          <dt class="text-(--ui-text-muted)">sha256</dt>
          <dd class="truncate font-mono text-xs">{{ detail.sha256 }}</dd>
        </dl>

        <div>
          <p class="mb-1 text-sm text-(--ui-text-muted)">{{ $t('media.organization') }}</p>
          <USelect
            :model-value="detail.organizationId ?? undefined"
            :items="orgs.map(o => ({ label: o.name, value: o.id }))"
            :placeholder="$t('media.noOrganization')"
            @update:model-value="(v:any) => assignOrg(v ?? null)"
          />
          <UButton v-if="detail.organizationId" variant="link" size="xs" class="mt-1" @click="assignOrg(null)">
            {{ $t('media.clearOrganization') }}
          </UButton>
        </div>

        <div>
          <p class="mb-1 text-sm text-(--ui-text-muted)">{{ $t('media.usedInPlaylists') }} ({{ detail.playlists.length }})</p>
          <ul class="space-y-1 text-sm">
            <li v-for="p in detail.playlists" :key="p.id">{{ p.name }}</li>
            <li v-if="detail.playlists.length === 0" class="text-(--ui-text-muted)">{{ $t('media.notUsed') }}</li>
          </ul>
        </div>
      </div>
    </template>
  </USlideover>
</template>
```
(Confirm the Nuxt UI v3 `USlideover` prop names against the version in use; adjust `v-model:open`/`#body` if the installed API differs.)

- [ ] **Step 2: Wire into the page.** In `app/pages/media.vue`: add `const selectedId = ref<number | null>(null)`, pass `@select="selectedId = m.id"` to `MediaCard`, render `<MediaDetailDrawer :media-id="selectedId" @update:open="selectedId = null" @changed="store.refresh()" />`.

- [ ] **Step 3: Verify** — clicking a card opens the drawer; assigning an org persists (reload list shows it); play count visible. (Manual; Task 10.)

- [ ] **Step 4: Commit**

```bash
git add app/components/MediaDetailDrawer.vue app/components/MediaCard.vue app/pages/media.vue
git commit -m "feat(media): detail drawer with metadata, usage, org assignment, play count"
```

---

## Task 9: Portal "Plays" column + i18n

**Files:**
- Modify: `app/pages/portal/index.vue`, `i18n/locales/en.json`, `i18n/locales/uk.json`

- [ ] **Step 1: Portal column.** In `app/pages/portal/index.vue`, add a header `<th …>{{ $t('portal.colPlays') }}</th>` and a cell `<td class="px-5 py-3 tabular-nums">{{ m.playCount }}</td>`; fix the empty-row `colspan` (now 6). Add a poll so counts rise:
```ts
let timer: ReturnType<typeof setInterval> | null = null
async function refresh() { try { stats.value = await api.getPortalStats() } catch { /* keep */ } }
onMounted(() => { timer = setInterval(refresh, 5000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
```

- [ ] **Step 2: i18n keys.** Add to both `en.json` and `uk.json` (English values shown; provide natural Ukrainian for the `uk` file):
```
devices.nowPlaying = "Now playing" / "Зараз відтворюється"
devices.online = "Online" / "У мережі"
devices.offline = "Offline" / "Не в мережі"
devices.nothingPlaying = "Nothing playing" / "Нічого не відтворюється"
media.details = "Media details" / "Деталі медіа"
media.plays = "Plays" / "Відтворень"
media.type = "Type" / "Тип"
media.size = "Size" / "Розмір"
media.dimensions = "Dimensions" / "Розміри"
media.duration = "Duration" / "Тривалість"
media.uploaded = "Uploaded" / "Завантажено"
media.organization = "Organization" / "Організація"
media.noOrganization = "No organization" / "Без організації"
media.clearOrganization = "Clear" / "Очистити"
media.usedInPlaylists = "Used in playlists" / "Використовується в плейлистах"
media.notUsed = "Not used in any playlist" / "Не використовується"
media.orgUpdated = "Organization updated" / "Організацію оновлено"
media.orgUpdateFailed = "Failed to update organization" / "Не вдалося оновити організацію"
portal.colPlays = "Plays" / "Відтворень"
```

- [ ] **Step 3: Build** — Run `pnpm build`. Expected: success (no missing-key/type errors that break build).

- [ ] **Step 4: Commit**

```bash
git add app/pages/portal/index.vue i18n/locales/en.json i18n/locales/uk.json
git commit -m "feat(portal): plays column + i18n for new dashboard surfaces"
```

---

## Task 10: Full-suite + live verification

- [ ] **Step 1:** Run `pnpm test`. Expected: full suite green.
- [ ] **Step 2:** Run `pnpm build`. Expected: success.
- [ ] **Step 3: Live box check.** With dev server (`HOST=0.0.0.0 PORT=5100 pnpm dev`) and the Tanix box playing the assigned playlist:
  - Device page (`/devices/3ef8430e-…`) shows "Now playing: IMG_5609.MP4 · test" + Online.
  - Media drawer for that video shows play count rising every ~5s.
  - Assign the video's media to an organization; assign that org to the `client@lanka.live` user; log into `/portal` as the client and confirm the media row shows a rising **Plays** count.
- [ ] **Step 4: Final commit** (if any tweaks):

```bash
git add -A
git commit -m "test: verify dashboard now-playing + media detail + play counts on device"
```

---

## Notes for the implementer
- Tests: Vitest `pool: 'forks'`; call `handleXxx` directly (see `tests/api/devices-telemetry.test.ts`). Keep `tests/helpers/nuxt-stubs.ts` updated if a new Nitro auto-import is used by a server file imported in tests.
- Gate on `pnpm test` + `pnpm build`, not `pnpm typecheck` (pre-existing vue-tsc errors).
- `~` resolves to project root in vitest and Nuxt.
- The player/APK needs **no** changes — counting reuses existing telemetry.
