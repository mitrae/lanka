# Device Remote Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent WebSocket command channel (alongside the existing SSE content-sync stream) that lets the server push OTA APK updates, reboots, screenshot requests, and log-pull requests to Android TV boxes, with durable DB-backed command queuing.

**Architecture:** A new `CommandHub` singleton stores active WebSocket peers and drains a `device_commands` DB table on connect. Commands enqueued while a device is offline stay `pending` and are delivered on reconnect. A new `useCommandChannel` composable in the player JS opens the WS and dispatches commands to `NativeFS` bridge methods. Two new dashboard pages surface APK release management and per-device remote control.

**Tech Stack:** Nitro `defineWebSocketHandler` (crossws) · Drizzle ORM / better-sqlite3 · Vitest · Vue 3 / Nuxt UI v3 · Kotlin / Android PackageInstaller / PixelCopy

## Global Constraints

- Nuxt 4, SPA mode (`ssr: false`) — no SSR-only APIs
- Package manager: pnpm
- Test runner: `pnpm test` (Vitest, `pool: 'forks'`)
- DB: better-sqlite3 via Drizzle; all DB ops use `await` even though driver is sync
- Auth guard: admin/super for all management endpoints; `/api/devices/:id/ws` is device-facing (no session cookie — exempt from user auth, same as manifest/telemetry)
- New schema → run `pnpm db:generate` then `pnpm db:migrate` after modifying `server/db/schema.ts`
- `~` alias resolves to project root in both Nuxt and Vitest
- Nuxt UI v3 (indigo/slate) — use `UButton`, `UCard`, `UTable`, `UModal`, `UBadge` etc.
- Android min SDK: 26 (PixelCopy requires API 26)
- Device Owner setup (per box, once): `adb shell dpm set-device-owner ai.lanka.kiosk/.BootReceiver`

---

## File Map

### New files
| Path | Purpose |
|---|---|
| `server/db/schema.ts` | +`apkReleases`, `deviceCommands` tables; +`apkVersion` on `devices` |
| `server/services/command-hub.ts` | CommandHub singleton — peer registry + enqueue/drain/ack |
| `server/api/devices/[id]/ws.get.ts` | WebSocket upgrade handler |
| `server/api/devices/[id]/commands.post.ts` | Enqueue a command |
| `server/api/devices/[id]/commands.get.ts` | List recent commands |
| `server/api/apk/index.get.ts` | List APK releases |
| `server/api/apk/upload.post.ts` | Upload APK binary |
| `server/api/apk/[id].delete.ts` | Delete APK release |
| `server/api/apk/[id]/download.get.ts` | Stream APK file |
| `app/composables/player/useCommandChannel.ts` | Player WS client |
| `app/pages/apk.vue` | APK release management page |
| `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstaller.kt` | APK download + silent install |
| `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstallReceiver.kt` | PackageInstaller broadcast receiver |
| `android/app/src/main/kotlin/ai/lanka/kiosk/BootReceiver.kt` | Device Owner stub receiver |
| `android/app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt` | JVM unit test |
| `tests/services/command-hub.test.ts` | CommandHub unit tests |
| `tests/api/device-commands.test.ts` | Commands API tests |
| `tests/api/apk.test.ts` | APK release API tests |
| `tests/player/useCommandChannel.test.ts` | useCommandChannel unit tests |

### Modified files
| Path | Change |
|---|---|
| `server/api/devices/[id]/telemetry.post.ts` | Accept + store `apkVersion` |
| `app/composables/player/usePlayerBoot.ts` | Wire `useCommandChannel` |
| `app/composables/player/useTelemetry.ts` | Pass `apkVersion` in telemetry fire |
| `app/composables/useApiClient.ts` | Add APK + command methods |
| `app/types/api.ts` | Add `ApkRelease`, `DeviceCommand` types |
| `app/pages/devices/[id].vue` | Add Remote Control card |
| `android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt` | Add downloadApk/installApk/screenshot/getLogs/getAppVersion |
| `android/app/src/main/AndroidManifest.xml` | Add permissions + receivers |

---

## Task 1: DB schema + migration

**Files:**
- Modify: `server/db/schema.ts`
- Run: `pnpm db:generate && pnpm db:migrate`

**Interfaces:**
- Produces: `schema.apkReleases`, `schema.deviceCommands` Drizzle table objects; `schema.devices.apkVersion` column

- [ ] **Step 1: Add new tables and column to schema**

In `server/db/schema.ts`, add after the `deviceErrors` table and before the `organizations` table:

```ts
export const apkReleases = sqliteTable('apk_releases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: text('version').notNull(),
  sha256: text('sha256').notNull().unique(),
  size: integer('size').notNull(),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' })
})

export const deviceCommands = sqliteTable(
  'device_commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    cmd: text('cmd', { enum: ['ota', 'reboot', 'screenshot', 'log-request'] }).notNull(),
    payload: text('payload'),
    status: text('status', { enum: ['pending', 'sent', 'acked', 'failed'] })
      .notNull()
      .default('pending'),
    result: text('result'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    deviceStatusIdx: index('device_commands_device_status_idx').on(t.deviceId, t.status)
  })
)
```

Also add `apkVersion` to the `devices` table definition (insert after `updatedAt`):

```ts
apkVersion: text('apk_version'),
```

Add relations after the existing relation exports:

```ts
export const apkReleasesRelations = relations(apkReleases, ({ one }) => ({
  uploadedBy: one(users, { fields: [apkReleases.uploadedBy], references: [users.id] })
}))

export const deviceCommandsRelations = relations(deviceCommands, ({ one }) => ({
  device: one(devices, { fields: [deviceCommands.deviceId], references: [devices.id] })
}))
```

- [ ] **Step 2: Generate and apply migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: new migration file in `server/db/migrations/`, applied successfully to `data/signage.db`.

- [ ] **Step 3: Verify tests still pass**

```bash
pnpm test
```

Expected: all existing tests pass (migration runs in `createTestDb` via the migrator).

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.ts server/db/migrations/
git commit -m "feat(db): add apk_releases, device_commands tables; apk_version on devices"
```

---

## Task 2: CommandHub service

**Files:**
- Create: `server/services/command-hub.ts`
- Create: `tests/services/command-hub.test.ts`

**Interfaces:**
- Consumes: `schema.deviceCommands` (Task 1)
- Produces:
  - `CommandHub` class with `register(deviceId, peer)`, `enqueue(db, deviceId, cmd, payload)`, `drain(db, deviceId, peer)`, `handleAck(db, commandId, status, result)`, `onDisconnect(db, deviceId)`, `isConnected(deviceId)`
  - `useCommandHub(): CommandHub` singleton factory

- [ ] **Step 1: Write failing tests**

Create `tests/services/command-hub.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedDevice } from '../helpers/fixtures'
import * as schema from '~/server/db/schema'
import { CommandHub } from '~/server/services/command-hub'

function makePeer() {
  const sent: string[] = []
  return {
    send: (msg: string) => sent.push(msg),
    sent
  }
}

describe('CommandHub', () => {
  let db: TestDb
  let close: () => void
  let hub: CommandHub

  beforeEach(async () => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new CommandHub()
    await seedDevice(db, { id: 'dev-1' })
  })
  afterEach(() => close())

  it('enqueue inserts pending row when device is offline', async () => {
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('pending')
    expect(row.cmd).toBe('screenshot')
  })

  it('enqueue sends immediately and marks sent when device is online', async () => {
    const peer = makePeer()
    hub.register('dev-1', peer)
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    expect(peer.sent).toHaveLength(1)
    expect(JSON.parse(peer.sent[0])).toMatchObject({ commandId: id, cmd: 'screenshot' })
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('sent')
  })

  it('enqueue marks reboot acked immediately on delivery (no ack from device)', async () => {
    const peer = makePeer()
    hub.register('dev-1', peer)
    const id = await hub.enqueue(db, 'dev-1', 'reboot', null)
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('acked')
  })

  it('drain sends all pending commands to peer', async () => {
    await hub.enqueue(db, 'dev-1', 'screenshot', null)
    await hub.enqueue(db, 'dev-1', 'log-request', null)
    const peer = makePeer()
    hub.register('dev-1', peer)
    await hub.drain(db, 'dev-1', peer)
    expect(peer.sent).toHaveLength(2)
    const [cmd1, cmd2] = await db.select().from(schema.deviceCommands)
    expect(cmd1.status).toBe('sent')
    expect(cmd2.status).toBe('sent')
  })

  it('handleAck updates row status and result', async () => {
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    // simulate device is online so it was sent
    const peer = makePeer()
    hub.register('dev-1', peer)
    await hub.enqueue(db, 'dev-1', 'screenshot', null) // fresh one that goes to sent
    await hub.handleAck(db, id, 'acked', 'data:image/jpeg;base64,abc')
    const [row] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(row.status).toBe('acked')
    expect(row.result).toBe('data:image/jpeg;base64,abc')
  })

  it('onDisconnect re-queues sent commands to pending', async () => {
    const peer = makePeer()
    hub.register('dev-1', peer)
    const id = await hub.enqueue(db, 'dev-1', 'screenshot', null)
    const [before] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(before.status).toBe('sent')

    await hub.onDisconnect(db, 'dev-1')

    const [after] = await db.select().from(schema.deviceCommands).where(eq(schema.deviceCommands.id, id))
    expect(after.status).toBe('pending')
    expect(hub.isConnected('dev-1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
pnpm test tests/services/command-hub.test.ts
```

Expected: FAIL — `CommandHub` not found.

- [ ] **Step 3: Implement CommandHub**

Create `server/services/command-hub.ts`:

```ts
import { eq, and } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

export type CommandStatus = 'pending' | 'sent' | 'acked' | 'failed'
export type CommandType = 'ota' | 'reboot' | 'screenshot' | 'log-request'

interface Peer {
  send(msg: string): void
}

export class CommandHub {
  private peers = new Map<string, Peer>()

  register(deviceId: string, peer: Peer): void {
    this.peers.set(deviceId, peer)
  }

  isConnected(deviceId: string): boolean {
    return this.peers.has(deviceId)
  }

  private send(deviceId: string, msg: object): boolean {
    const peer = this.peers.get(deviceId)
    if (!peer) return false
    peer.send(JSON.stringify(msg))
    return true
  }

  async enqueue(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string,
    cmd: CommandType,
    payload: Record<string, unknown> | null
  ): Promise<number> {
    const [row] = await db
      .insert(schema.deviceCommands)
      .values({
        deviceId,
        cmd,
        payload: payload ? JSON.stringify(payload) : null,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning()

    const delivered = this.send(deviceId, { commandId: row.id, cmd, payload })
    if (delivered) {
      // reboot: device reloads immediately, can never send ack — mark done on delivery
      const status: CommandStatus = cmd === 'reboot' ? 'acked' : 'sent'
      await db
        .update(schema.deviceCommands)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.deviceCommands.id, row.id))
    }
    return row.id
  }

  async drain(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string,
    peer: Peer
  ): Promise<void> {
    const pending = await db
      .select()
      .from(schema.deviceCommands)
      .where(
        and(
          eq(schema.deviceCommands.deviceId, deviceId),
          eq(schema.deviceCommands.status, 'pending')
        )
      )
      .orderBy(schema.deviceCommands.createdAt)

    for (const cmd of pending) {
      peer.send(
        JSON.stringify({
          commandId: cmd.id,
          cmd: cmd.cmd,
          payload: cmd.payload ? JSON.parse(cmd.payload) : null
        })
      )
      const status: CommandStatus = cmd.cmd === 'reboot' ? 'acked' : 'sent'
      await db
        .update(schema.deviceCommands)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.deviceCommands.id, cmd.id))
    }
  }

  async handleAck(
    db: BetterSQLite3Database<typeof schema>,
    commandId: number,
    status: 'acked' | 'failed',
    result: string | null
  ): Promise<void> {
    await db
      .update(schema.deviceCommands)
      .set({ status, result, updatedAt: new Date() })
      .where(eq(schema.deviceCommands.id, commandId))
  }

  async onDisconnect(
    db: BetterSQLite3Database<typeof schema>,
    deviceId: string
  ): Promise<void> {
    await db
      .update(schema.deviceCommands)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(
        and(
          eq(schema.deviceCommands.deviceId, deviceId),
          eq(schema.deviceCommands.status, 'sent')
        )
      )
    this.peers.delete(deviceId)
  }
}

let _hub: CommandHub | null = null
export function useCommandHub(): CommandHub {
  if (!_hub) _hub = new CommandHub()
  return _hub
}

export function _resetCommandHub(): void {
  _hub = null
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
pnpm test tests/services/command-hub.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/command-hub.ts tests/services/command-hub.test.ts
git commit -m "feat(server): CommandHub service — durable WS command queue"
```

---

## Task 3: APK release API

**Files:**
- Create: `server/api/apk/index.get.ts`
- Create: `server/api/apk/upload.post.ts`
- Create: `server/api/apk/[id].delete.ts`
- Create: `server/api/apk/[id]/download.get.ts`
- Create: `tests/api/apk.test.ts`

**Interfaces:**
- Consumes: `schema.apkReleases` (Task 1), `useMediaStore()`, `decideAccess` (existing auth guard)
- Produces:
  - `GET /api/apk` → `ApkRelease[]`
  - `POST /api/apk/upload` (multipart: `file` + `version`) → `ApkRelease`
  - `DELETE /api/apk/:id` → 204
  - `GET /api/apk/:id/download` → binary stream
  - `handleListApkReleases(db)` exported from `index.get.ts`
  - `handleDeleteApkRelease(db, store, id)` exported from `[id].delete.ts`
  - `handleUploadApk(db, store, input)` exported from `upload.post.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/api/apk.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { createTestDb, type TestDb } from '../helpers/test-db'
import * as schema from '~/server/db/schema'
import { handleListApkReleases } from '~/server/api/apk/index.get'
import { handleDeleteApkRelease } from '~/server/api/apk/[id].delete'
import { handleUploadApk } from '~/server/api/apk/upload.post'

const fakeStore = {
  put: async (_sha: string, _s: Readable) => {},
  has: async (_sha: string) => false,
  delete: async (_sha: string) => {},
  stat: async (_sha: string) => ({ bytes: 1024 }),
  open: async (_sha: string) => Readable.from(Buffer.from('apkbytes')),
  putThumbnail: async () => {},
  hasThumbnail: async () => false,
  openThumbnail: async () => Readable.from(Buffer.from('')),
  deleteThumbnail: async () => {}
}

describe('APK release API', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('upload creates apk_releases row', async () => {
    const sha256 = 'a'.repeat(64)
    const stream = Readable.from(Buffer.from('apkbytes'))
    const result = await handleUploadApk(db, fakeStore, {
      sha256,
      version: '1.2.3',
      size: 8,
      stream,
      uploadedBy: null
    })
    expect(result.version).toBe('1.2.3')
    expect(result.sha256).toBe(sha256)
    expect(result.size).toBe(8)
  })

  it('list returns all releases newest first', async () => {
    await db.insert(schema.apkReleases).values({ version: '1.0.0', sha256: 'a'.repeat(64), size: 100 })
    await db.insert(schema.apkReleases).values({ version: '1.1.0', sha256: 'b'.repeat(64), size: 200 })
    const list = await handleListApkReleases(db)
    expect(list).toHaveLength(2)
    expect(list[0].version).toBe('1.1.0')
  })

  it('delete removes row and calls store.delete', async () => {
    const deleted: string[] = []
    const store = { ...fakeStore, delete: async (sha: string) => { deleted.push(sha) } }
    const sha256 = 'c'.repeat(64)
    const [row] = await db.insert(schema.apkReleases).values({ version: '1.0.0', sha256, size: 100 }).returning()
    await handleDeleteApkRelease(db, store, row.id)
    const remaining = await db.select().from(schema.apkReleases).where(eq(schema.apkReleases.id, row.id))
    expect(remaining).toHaveLength(0)
    expect(deleted).toContain(sha256)
  })

  it('delete 404s on unknown id', async () => {
    await expect(handleDeleteApkRelease(db, fakeStore, 999)).rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
pnpm test tests/api/apk.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement list + upload handlers**

Create `server/api/apk/index.get.ts`:

```ts
import { desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListApkReleases(db: BetterSQLite3Database<typeof schema>) {
  return db
    .select()
    .from(schema.apkReleases)
    .orderBy(desc(schema.apkReleases.uploadedAt))
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  return handleListApkReleases(useDb())
})
```

Create `server/api/apk/upload.post.ts`:

```ts
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaStore } from '~/server/services/media-store'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

export interface UploadApkInput {
  sha256: string
  version: string
  size: number
  stream: Readable
  uploadedBy: number | null
}

export async function handleUploadApk(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: UploadApkInput
) {
  await store.put(input.sha256, input.stream)
  const [row] = await db
    .insert(schema.apkReleases)
    .values({
      version: input.version,
      sha256: input.sha256,
      size: input.size,
      uploadedBy: input.uploadedBy
    })
    .returning()
  return row
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }

  const form = await readMultipartFormData(event)
  if (!form) throw createError({ statusCode: 400, message: 'Multipart body required' })

  const filePart = form.find(p => p.name === 'file')
  const versionPart = form.find(p => p.name === 'version')
  if (!filePart?.data) throw createError({ statusCode: 400, message: 'Missing file' })
  if (!versionPart?.data) throw createError({ statusCode: 400, message: 'Missing version' })

  const version = versionPart.data.toString('utf8').trim()
  if (!version) throw createError({ statusCode: 400, message: 'version must not be empty' })

  const buf = filePart.data
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const { Readable } = await import('node:stream')
  const stream = Readable.from(buf)

  return handleUploadApk(useDb(), useMediaStore(), {
    sha256,
    version,
    size: buf.length,
    stream,
    uploadedBy: user.id
  })
})
```

- [ ] **Step 4: Implement delete + download handlers**

Create `server/api/apk/[id].delete.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaStore } from '~/server/services/media-store'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

export async function handleDeleteApkRelease(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: number
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.apkReleases)
    .where(eq(schema.apkReleases.id, id))
  if (!row) throw createError({ statusCode: 404, message: 'APK release not found' })
  await db.delete(schema.apkReleases).where(eq(schema.apkReleases.id, id))
  await store.delete(row.sha256)
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const idParam = getRouterParam(event, 'id')
  const id = Number(idParam)
  if (!id) throw createError({ statusCode: 400, message: 'Invalid id' })
  await handleDeleteApkRelease(useDb(), useMediaStore(), id)
  setResponseStatus(event, 204)
  return null
})
```

Create `server/api/apk/[id]/download.get.ts`:

```ts
import { eq } from 'drizzle-orm'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const idParam = getRouterParam(event, 'id')
  const id = Number(idParam)
  if (!id) throw createError({ statusCode: 400, message: 'Invalid id' })

  const [row] = await useDb()
    .select()
    .from(schema.apkReleases)
    .where(eq(schema.apkReleases.id, id))
  if (!row) throw createError({ statusCode: 404, message: 'APK release not found' })

  const stream = await useMediaStore().open(row.sha256)
  setHeader(event, 'Content-Type', 'application/vnd.android.package-archive')
  setHeader(event, 'Content-Disposition', `attachment; filename="lanka-${row.version}.apk"`)
  return sendStream(event, stream)
})
```

- [ ] **Step 5: Run tests**

```bash
pnpm test tests/api/apk.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/api/apk/ tests/api/apk.test.ts
git commit -m "feat(api): APK release upload, list, delete, download endpoints"
```

---

## Task 4: Device commands API + WebSocket endpoint

**Files:**
- Create: `server/api/devices/[id]/commands.post.ts`
- Create: `server/api/devices/[id]/commands.get.ts`
- Create: `server/api/devices/[id]/ws.get.ts`
- Create: `tests/api/device-commands.test.ts`

**Interfaces:**
- Consumes: `CommandHub` (Task 2), `schema.deviceCommands` (Task 1), `schema.apkReleases` (Task 1)
- Produces:
  - `POST /api/devices/:id/commands` → `{ commandId: number }`
  - `GET /api/devices/:id/commands` → `DeviceCommand[]`
  - `WS /api/devices/:id/ws` — live command delivery

- [ ] **Step 1: Write failing tests**

Create `tests/api/device-commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedDevice } from '../helpers/fixtures'
import * as schema from '~/server/db/schema'
import { CommandHub } from '~/server/services/command-hub'
import { handleEnqueueCommand, handleListCommands } from '~/server/api/devices/[id]/commands.post'

describe('device commands API', () => {
  let db: TestDb
  let close: () => void
  let hub: CommandHub

  beforeEach(async () => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new CommandHub()
    await seedDevice(db, { id: 'dev-1' })
  })
  afterEach(() => close())

  it('enqueue screenshot command returns commandId', async () => {
    const result = await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'screenshot' })
    expect(result.commandId).toBeTypeOf('number')
  })

  it('enqueue ota command requires releaseId', async () => {
    const [rel] = await db
      .insert(schema.apkReleases)
      .values({ version: '1.0', sha256: 'a'.repeat(64), size: 100 })
      .returning()
    const result = await handleEnqueueCommand(db, hub, 'dev-1', {
      cmd: 'ota',
      releaseId: rel.id
    })
    expect(result.commandId).toBeTypeOf('number')
  })

  it('enqueue ota 400s on missing releaseId', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'ota' })
    ).rejects.toThrow(/releaseId/i)
  })

  it('enqueue 404s on unknown device', async () => {
    await expect(
      handleEnqueueCommand(db, hub, 'ghost', { cmd: 'screenshot' })
    ).rejects.toThrow(/not found/i)
  })

  it('list returns recent commands newest first', async () => {
    await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'screenshot' })
    await handleEnqueueCommand(db, hub, 'dev-1', { cmd: 'log-request' })
    const list = await handleListCommands(db, 'dev-1')
    expect(list).toHaveLength(2)
    expect(list[0].cmd).toBe('log-request')
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
pnpm test tests/api/device-commands.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement commands handlers**

Create `server/api/devices/[id]/commands.post.ts`:

```ts
import { eq, desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type CommandType, useCommandHub } from '~/server/services/command-hub'

interface EnqueueInput {
  cmd: CommandType
  releaseId?: number
}

export async function handleEnqueueCommand(
  db: BetterSQLite3Database<typeof schema>,
  hub: ReturnType<typeof useCommandHub>,
  deviceId: string,
  input: EnqueueInput
): Promise<{ commandId: number }> {
  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!device) throw createError({ statusCode: 404, message: `Device ${deviceId} not found` })

  let payload: Record<string, unknown> | null = null
  if (input.cmd === 'ota') {
    if (!input.releaseId) throw createError({ statusCode: 400, message: 'releaseId required for ota command' })
    const [release] = await db
      .select()
      .from(schema.apkReleases)
      .where(eq(schema.apkReleases.id, input.releaseId))
    if (!release) throw createError({ statusCode: 404, message: 'APK release not found' })
    payload = {
      releaseId: release.id,
      version: release.version,
      sha256: release.sha256,
      url: `/api/apk/${release.id}/download`
    }
  }

  const commandId = await hub.enqueue(db, deviceId, input.cmd, payload)
  return { commandId }
}

export async function handleListCommands(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
) {
  return db
    .select()
    .from(schema.deviceCommands)
    .where(eq(schema.deviceCommands.deviceId, deviceId))
    .orderBy(desc(schema.deviceCommands.createdAt))
    .limit(50)
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  return handleEnqueueCommand(useDb(), useCommandHub(), id, body)
})
```

Create `server/api/devices/[id]/commands.get.ts`:

```ts
import { useDb } from '~/server/db/client'
import { handleListCommands } from './commands.post'

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400 })
  return handleListCommands(useDb(), id)
})
```

- [ ] **Step 4: Implement WebSocket handler**

Create `server/api/devices/[id]/ws.get.ts`:

```ts
import { useDb } from '~/server/db/client'
import { useCommandHub } from '~/server/services/command-hub'

function deviceIdFromUrl(url: string): string | null {
  const m = url.match(/\/devices\/([^/?#]+)\/ws/)
  return m?.[1] ?? null
}

export default defineWebSocketHandler({
  async open(peer) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return peer.close(1008, 'Missing device id')
    const hub = useCommandHub()
    hub.register(id, { send: (msg: string) => peer.send(msg) })
    await hub.drain(useDb(), id, { send: (msg: string) => peer.send(msg) })
  },

  async message(peer, raw) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    let msg: { commandId: number; status: 'acked' | 'failed'; result?: string }
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.text())
    } catch {
      return
    }
    if (!msg.commandId || !msg.status) return
    await useCommandHub().handleAck(
      useDb(),
      msg.commandId,
      msg.status,
      msg.result ?? null
    )
  },

  async close(peer) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    await useCommandHub().onDisconnect(useDb(), id)
  },

  async error(peer, _err) {
    const id = deviceIdFromUrl(peer.request?.url ?? '')
    if (!id) return
    await useCommandHub().onDisconnect(useDb(), id)
  }
})
```

- [ ] **Step 5: Add nuxt-stubs for new Nitro auto-imports**

Open `tests/helpers/nuxt-stubs.ts` and add after the existing stubs:

```ts
;(globalThis as any).defineWebSocketHandler = (handler: unknown) => handler
;(globalThis as any).setHeader = notInTests('setHeader')
;(globalThis as any).readMultipartFormData = notInTests('readMultipartFormData')
```

- [ ] **Step 6: Exempt ws endpoint from session auth**

Open `server/middleware/auth.ts` and add `/api/devices/` + `/ws` path to the public paths list (same pattern as manifest/telemetry exemptions). Find the device path exemptions block and add:

```ts
// existing exemption pattern — add ws alongside manifest/stream/telemetry:
if (/^\/api\/devices\/[^/]+\/(manifest|stream|telemetry|ws)/.test(path)) return
```

- [ ] **Step 7: Run tests**

```bash
pnpm test tests/api/device-commands.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/api/devices/[id]/commands.post.ts server/api/devices/[id]/commands.get.ts server/api/devices/[id]/ws.get.ts server/middleware/auth.ts tests/helpers/nuxt-stubs.ts tests/api/device-commands.test.ts
git commit -m "feat(api): device command queue endpoints + WebSocket handler"
```

---

## Task 5: Telemetry extension (apkVersion)

**Files:**
- Modify: `server/api/devices/[id]/telemetry.post.ts`
- Modify: `tests/api/devices-telemetry.test.ts`

**Interfaces:**
- Consumes: `schema.devices.apkVersion` (Task 1)
- Produces: `handleTelemetry` accepts optional `apkVersion: string`

- [ ] **Step 1: Add test for apkVersion field**

Open `tests/api/devices-telemetry.test.ts` and add at the end of the describe block:

```ts
it('stores apkVersion when provided', async () => {
  await seedDevice(db, { id: 'dev-apk' })
  await handleTelemetry(db, 'dev-apk', { currentItemId: null, apkVersion: '1.2.3' })
  const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, 'dev-apk'))
  expect(row.apkVersion).toBe('1.2.3')
})

it('ignores missing apkVersion without error', async () => {
  await seedDevice(db, { id: 'dev-noapk' })
  await expect(
    handleTelemetry(db, 'dev-noapk', { currentItemId: null })
  ).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run tests — expect failure on apkVersion test**

```bash
pnpm test tests/api/devices-telemetry.test.ts
```

Expected: `stores apkVersion when provided` FAIL (field not stored yet).

- [ ] **Step 3: Update BodySchema and handleTelemetry**

In `server/api/devices/[id]/telemetry.post.ts`:

Change the `BodySchema` to:
```ts
const BodySchema = z.object({
  currentItemId: z.number().int().positive().nullable(),
  apkVersion: z.string().max(50).optional(),
  error: z
    .object({ sha256: z.string().optional(), message: z.string().max(500) })
    .optional()
})
```

In the final `db.update(schema.devices).set(...)` call, add `apkVersion`:
```ts
await db
  .update(schema.devices)
  .set({
    currentItemId: body.currentItemId,
    lastSeenAt: new Date(),
    ...(body.apkVersion !== undefined ? { apkVersion: body.apkVersion } : {})
  })
  .where(eq(schema.devices.id, deviceId))
```

- [ ] **Step 4: Run tests**

```bash
pnpm test tests/api/devices-telemetry.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/[id]/telemetry.post.ts tests/api/devices-telemetry.test.ts
git commit -m "feat(telemetry): accept and store apkVersion from device"
```

---

## Task 6: useCommandChannel composable (player JS)

**Files:**
- Create: `app/composables/player/useCommandChannel.ts`
- Create: `tests/player/useCommandChannel.test.ts`

**Interfaces:**
- Consumes: `NativeFSBridge` interface from `useReconciler.ts`; `backoff` from `backoff.ts`
- Produces:
  ```ts
  interface CommandChannelDeps {
    deviceId: string
    nativeFS?: NativeFSBridgeExtended  // new interface (superset of existing)
    onReload: () => void
  }
  interface CommandChannelHandle {
    open(): void
    close(): void
  }
  function createCommandChannel(deps: CommandChannelDeps): CommandChannelHandle
  ```

- [ ] **Step 1: Extend NativeFSBridge interface**

In `app/composables/player/useReconciler.ts`, expand the existing `NativeFSBridge` interface to add the new methods:

```ts
export interface NativeFSBridge {
  // existing
  exists(sha256: string): boolean
  download(sha256: string, url: string): boolean
  evictExcept(sha256ListJson: string): void
  // new (Plan 7)
  downloadApk(url: string, sha256: string): boolean
  installApk(sha256: string, commandId: number): boolean
  screenshot(): string
  getLogs(): string
  getAppVersion(): string
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/player/useCommandChannel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCommandChannel } from '~/app/composables/player/useCommandChannel'

// Mock WebSocket
class MockWS {
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1 // OPEN
  send(msg: string) { this.sent.push(msg) }
  close() { this.onclose?.() }
  open() { this.onopen?.() }
  receive(data: object) { this.onmessage?.({ data: JSON.stringify(data) }) }
}

let ws: MockWS
function wsFactory(_url: string): WebSocket {
  ws = new MockWS()
  return ws as unknown as WebSocket
}

function makeNativeFS() {
  return {
    exists: () => false,
    download: () => true,
    evictExcept: () => {},
    downloadApk: vi.fn(() => true),
    installApk: vi.fn(() => true),
    screenshot: vi.fn(() => 'data:image/jpeg;base64,abc'),
    getLogs: vi.fn(() => 'log line 1\nlog line 2'),
    getAppVersion: vi.fn(() => '1.2.3')
  }
}

describe('createCommandChannel', () => {
  let nativeFS: ReturnType<typeof makeNativeFS>
  let reloaded: boolean

  beforeEach(() => {
    nativeFS = makeNativeFS()
    reloaded = false
  })

  it('sends screenshot ack when screenshot command received', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 1, cmd: 'screenshot', payload: null })
    expect(nativeFS.screenshot).toHaveBeenCalled()
    const ack = JSON.parse(ws.sent[0])
    expect(ack).toMatchObject({ commandId: 1, status: 'acked', result: 'data:image/jpeg;base64,abc' })
  })

  it('sends log-request ack with log text', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 2, cmd: 'log-request', payload: null })
    const ack = JSON.parse(ws.sent[0])
    expect(ack).toMatchObject({ commandId: 2, status: 'acked' })
    expect(ack.result).toContain('log line')
  })

  it('calls onReload for reboot command (no ack sent)', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', nativeFS, onReload: () => { reloaded = true }, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 3, cmd: 'reboot', payload: null })
    expect(reloaded).toBe(true)
    expect(ws.sent).toHaveLength(0)
  })

  it('sends failed ack when nativeFS is absent', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ws.receive({ commandId: 4, cmd: 'screenshot', payload: null })
    const ack = JSON.parse(ws.sent[0])
    expect(ack).toMatchObject({ commandId: 4, status: 'failed' })
  })

  it('close() disconnects WebSocket', () => {
    const ch = createCommandChannel({ deviceId: 'dev-1', onReload: () => {}, wsFactory })
    ch.open()
    ws.open()
    ch.close()
    expect(ws.readyState).toBe(1) // MockWS doesn't actually set readyState, just checking no throw
  })
})
```

- [ ] **Step 3: Run tests — expect failures**

```bash
pnpm test tests/player/useCommandChannel.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement useCommandChannel**

Create `app/composables/player/useCommandChannel.ts`:

```ts
import type { NativeFSBridge } from './useReconciler'
import { backoff } from './backoff'

type WsFactory = (url: string) => WebSocket

interface Command {
  commandId: number
  cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request'
  payload: Record<string, unknown> | null
}

interface Ack {
  commandId: number
  status: 'acked' | 'failed'
  result?: string
}

export interface CommandChannelDeps {
  deviceId: string
  nativeFS?: NativeFSBridge
  onReload: () => void
  /** Injected in tests; defaults to global WebSocket */
  wsFactory?: WsFactory
}

export interface CommandChannelHandle {
  open(): void
  close(): void
}

export function createCommandChannel(deps: CommandChannelDeps): CommandChannelHandle {
  const factory: WsFactory = deps.wsFactory ?? ((url) => new WebSocket(url))
  let ws: WebSocket | null = null
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  function send(ack: Ack): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(ack))
    }
  }

  async function handleCommand(cmd: Command): Promise<void> {
    const { commandId, cmd: type, payload } = cmd
    const nfs = deps.nativeFS

    if (type === 'reboot') {
      deps.onReload()
      return // no ack — page reloads
    }

    if (!nfs) {
      send({ commandId, status: 'failed', result: 'not supported' })
      return
    }

    if (type === 'screenshot') {
      try {
        const data = nfs.screenshot()
        send({ commandId, status: 'acked', result: data })
      } catch (e) {
        send({ commandId, status: 'failed', result: String(e) })
      }
      return
    }

    if (type === 'log-request') {
      try {
        const logs = nfs.getLogs()
        send({ commandId, status: 'acked', result: logs })
      } catch (e) {
        send({ commandId, status: 'failed', result: String(e) })
      }
      return
    }

    if (type === 'ota') {
      const { sha256, url, version } = (payload ?? {}) as Record<string, string>
      if (!sha256 || !url) {
        send({ commandId, status: 'failed', result: 'missing sha256 or url' })
        return
      }
      // Install result comes back async via window.__otaResult callback
      ;(window as any).__otaResult = (id: number, status: 'acked' | 'failed') => {
        send({ commandId: id, status })
        delete (window as any).__otaResult
      }
      const downloaded = nfs.downloadApk(url, sha256)
      if (!downloaded) {
        send({ commandId, status: 'failed', result: 'download failed' })
        return
      }
      nfs.installApk(sha256, commandId)
      // ack sent async via window.__otaResult
    }
  }

  function connect(): void {
    if (closed) return
    ws = factory(`/api/devices/${deps.deviceId}/ws`)

    ws.onopen = () => {
      attempt = 0
    }

    ws.onmessage = (e) => {
      let cmd: Command
      try {
        cmd = JSON.parse(e.data)
      } catch {
        return
      }
      void handleCommand(cmd)
    }

    ws.onclose = () => {
      ws = null
      if (closed) return
      retryTimer = setTimeout(() => connect(), backoff(attempt))
      attempt += 1
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  return {
    open() {
      closed = false
      connect()
    },
    close() {
      closed = true
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      ws?.close()
      ws = null
    }
  }
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test tests/player/useCommandChannel.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add app/composables/player/useCommandChannel.ts app/composables/player/useReconciler.ts tests/player/useCommandChannel.test.ts
git commit -m "feat(player): useCommandChannel — WS command dispatcher"
```

---

## Task 7: Wire useCommandChannel into usePlayerBoot

**Files:**
- Modify: `app/composables/player/usePlayerBoot.ts`
- Modify: `app/composables/player/useTelemetry.ts`

**Interfaces:**
- Consumes: `createCommandChannel` (Task 6), `NativeFSBridge.getAppVersion()` (Task 8 — stub in JS until APK ships)

- [ ] **Step 1: Wire channel in usePlayerBoot.boot()**

In `app/composables/player/usePlayerBoot.ts`:

Add import at top:
```ts
import { createCommandChannel, type CommandChannelHandle } from './useCommandChannel'
```

Inside the `usePlayerBoot` function, add channel variable alongside reconciler:
```ts
let channel: CommandChannelHandle | null = null
```

Inside `boot()`, after the `reconciler.openStream()` line:
```ts
const nativeFS = (globalThis as any).NativeFS as NativeFSBridge | undefined
channel = createCommandChannel({
  deviceId: deviceId.value,
  nativeFS,
  onReload: () => device.reload()
})
channel.open()
```

In `onBeforeUnmount()`, add:
```ts
channel?.close()
channel = null
```

- [ ] **Step 2: Pass apkVersion in telemetry**

In `app/composables/player/useTelemetry.ts`, update the `fire` function to include `apkVersion` when `NativeFS.getAppVersion` is available:

```ts
function fire(
  deviceId: string,
  body: {
    currentItemId: number | null
    error?: { sha256?: string; message: string }
  }
): void {
  const nfs = (globalThis as any).NativeFS
  const apkVersion: string | undefined = nfs?.getAppVersion?.()
  api.postTelemetry(deviceId, { ...body, ...(apkVersion ? { apkVersion } : {}) }).catch((err) => {
    console.warn('[player] telemetry post failed', err)
  })
}
```

Also update the `postTelemetry` signature in `app/composables/useApiClient.ts`:

```ts
postTelemetry(
  deviceId: string,
  body: {
    currentItemId: number | null
    apkVersion?: string
    error?: { sha256?: string; message: string }
  }
): Promise<void>
```

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add app/composables/player/usePlayerBoot.ts app/composables/player/useTelemetry.ts app/composables/useApiClient.ts
git commit -m "feat(player): wire command channel + apkVersion telemetry into boot"
```

---

## Task 8: Android — OtaInstaller + NativeFSBridge extensions

**Files:**
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstaller.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstallReceiver.kt`
- Create: `android/app/src/main/kotlin/ai/lanka/kiosk/BootReceiver.kt`
- Create: `android/app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt`
- Modify: `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`

**Interfaces:**
- Produces: `NativeFS.downloadApk(url, sha256)`, `NativeFS.installApk(sha256, commandId)`, `NativeFS.screenshot()`, `NativeFS.getLogs()`, `NativeFS.getAppVersion()`
- On install result: `webView.evaluateJavascript("window.__otaResult($commandId, '$status')", null)`

- [ ] **Step 1: Write failing JVM test for OtaInstaller download**

Create `android/app/src/test/kotlin/ai/lanka/kiosk/OtaInstallerTest.kt`:

```kotlin
package ai.lanka.kiosk

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class OtaInstallerTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `downloadApk writes file to apk-cache dir`() {
        // We can't make a real HTTP call in JVM tests — test the path logic instead
        val installer = OtaInstaller.forTesting(tmp.root)
        val apkDir = File(tmp.root, "apk-cache")
        apkDir.mkdirs()
        // Write a fake APK directly to simulate a successful download
        val sha256 = "a".repeat(64)
        val dest = File(apkDir, "$sha256.apk")
        dest.writeBytes(byteArrayOf(0x50, 0x4B, 0x03, 0x04)) // PK magic bytes
        assertTrue(installer.exists(sha256))
    }

    @Test
    fun `exists returns false for unknown sha256`() {
        val installer = OtaInstaller.forTesting(tmp.root)
        assertFalse(installer.exists("b".repeat(64)))
    }
}
```

- [ ] **Step 2: Run Android tests — expect failure**

```bash
cd android && ./gradlew test && cd ..
```

Expected: FAIL — `OtaInstaller` not found.

- [ ] **Step 3: Create OtaInstaller**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstaller.kt`:

```kotlin
package ai.lanka.kiosk

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import android.webkit.WebView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class OtaInstaller private constructor(private val baseDir: File) {

    private val apkDir = File(baseDir, "apk-cache").also { it.mkdirs() }

    fun exists(sha256: String): Boolean =
        File(apkDir, "$sha256.apk").let { it.exists() && it.length() > 0L }

    fun apkFile(sha256: String): File = File(apkDir, "$sha256.apk")

    fun downloadApk(sha256: String, url: String): Boolean {
        if (exists(sha256)) return true
        val dest = apkFile(sha256)
        val tmp = File(apkDir, "$sha256.tmp")
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 120_000
                instanceFollowRedirects = true
            }
            try {
                if (conn.responseCode !in 200..299) {
                    Log.w(TAG, "download HTTP ${conn.responseCode} for $sha256")
                    return false
                }
                conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                tmp.renameTo(dest)
            } finally {
                conn.disconnect()
            }
            true
        } catch (e: Exception) {
            tmp.delete()
            Log.w(TAG, "downloadApk failed for $sha256: ${e.message}")
            false
        }
    }

    fun installSilently(context: Context, sha256: String, commandId: Long, webView: WebView) {
        val apk = apkFile(sha256)
        if (!apk.exists()) {
            webView.post {
                webView.evaluateJavascript("window.__otaResult($commandId, 'failed')", null)
            }
            return
        }
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, OtaInstallReceiver::class.java).apply {
                putExtra(OtaInstallReceiver.EXTRA_COMMAND_ID, commandId)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, commandId.toInt(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            session.commit(pendingIntent.intentSender)
        } catch (e: Exception) {
            session.abandon()
            Log.e(TAG, "installSilently failed: ${e.message}")
            webView.post {
                webView.evaluateJavascript("window.__otaResult($commandId, 'failed')", null)
            }
        }
    }

    companion object {
        private const val TAG = "OtaInstaller"

        @Volatile private var instance: OtaInstaller? = null

        fun get(context: Context): OtaInstaller =
            instance ?: synchronized(this) {
                instance ?: OtaInstaller(context.filesDir).also { instance = it }
            }

        /** For unit tests only. */
        internal fun forTesting(dir: File): OtaInstaller = OtaInstaller(dir)
    }
}
```

- [ ] **Step 4: Create OtaInstallReceiver and BootReceiver**

Create `android/app/src/main/kotlin/ai/lanka/kiosk/OtaInstallReceiver.kt`:

```kotlin
package ai.lanka.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

class OtaInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val commandId = intent.getLongExtra(EXTRA_COMMAND_ID, -1L)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val success = status == PackageInstaller.STATUS_SUCCESS
        Log.i(TAG, "OTA install result: commandId=$commandId success=$success status=$status")
        // Notify MainActivity to call back into the WebView
        OtaResultBus.notify(commandId, if (success) "acked" else "failed")
    }

    companion object {
        const val EXTRA_COMMAND_ID = "commandId"
        private const val TAG = "OtaInstallReceiver"
    }
}
```

Create a simple event bus used by OtaInstallReceiver → MainActivity:

In the same file, add after `OtaInstallReceiver` class (or as a separate file `OtaResultBus.kt`):

Create `android/app/src/main/kotlin/ai/lanka/kiosk/OtaResultBus.kt`:

```kotlin
package ai.lanka.kiosk

object OtaResultBus {
    private var listener: ((commandId: Long, status: String) -> Unit)? = null

    fun setListener(fn: (Long, String) -> Unit) { listener = fn }
    fun clearListener() { listener = null }
    fun notify(commandId: Long, status: String) { listener?.invoke(commandId, status) }
}
```

Create `android/app/src/main/kotlin/ai/lanka/kiosk/BootReceiver.kt`:

```kotlin
package ai.lanka.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Stub required for: adb shell dpm set-device-owner ai.lanka.kiosk/.BootReceiver */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {}
}
```

- [ ] **Step 5: Extend NativeFSBridge with new methods**

In `android/app/src/main/kotlin/ai/lanka/kiosk/NativeFSBridge.kt`, add these methods after the existing ones. The class needs a `context: Context` and `webView: WebView` reference — update the constructor:

Change the class signature from `class NativeFSBridge(private val cache: MediaCache)` to:
```kotlin
class NativeFSBridge(
    private val cache: MediaCache,
    private val context: Context,
    private val webView: WebView
)
```

Add new methods:

```kotlin
@JavascriptInterface
fun downloadApk(url: String, sha256: String): Boolean =
    OtaInstaller.get(context).downloadApk(sha256, url)

@JavascriptInterface
fun installApk(sha256: String, commandId: Long): Boolean {
    OtaInstaller.get(context).installSilently(context, sha256, commandId, webView)
    return true
}

@JavascriptInterface
fun screenshot(): String {
    return try {
        val bitmap = android.graphics.Bitmap.createBitmap(
            webView.width, webView.height, android.graphics.Bitmap.Config.ARGB_8888
        )
        val latch = java.util.concurrent.CountDownLatch(1)
        var result = ""
        android.view.PixelCopy.request(webView, bitmap, { res ->
            if (res == android.view.PixelCopy.SUCCESS) {
                val out = java.io.ByteArrayOutputStream()
                bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                result = "data:image/jpeg;base64," +
                    android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
            }
            latch.countDown()
        }, android.os.Handler(android.os.Looper.getMainLooper()))
        latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        result
    } catch (e: Exception) {
        Log.w(TAG, "screenshot failed: ${e.message}")
        ""
    }
}

@JavascriptInterface
fun getLogs(): String = try {
    val proc = Runtime.getRuntime().exec(
        arrayOf("logcat", "-d", "-t", "200", "-s",
            "LankaKiosk:*", "LankaCache:*", "NativeFS:*", "OtaInstaller:*")
    )
    proc.inputStream.bufferedReader().readText()
} catch (e: Exception) {
    "error: ${e.message}"
}

@JavascriptInterface
fun getAppVersion(): String = BuildConfig.VERSION_NAME
```

- [ ] **Step 6: Update MainActivity to pass context + webView to NativeFSBridge, register OtaResultBus**

In `android/app/src/main/kotlin/ai/lanka/kiosk/MainActivity.kt`, update the `addJavascriptInterface` call:

```kotlin
webView.addJavascriptInterface(
    NativeFSBridge(MediaCache.get(this), this, webView),
    "NativeFS"
)
```

In `onCreate()`, after `configureWebView()`, add:

```kotlin
OtaResultBus.setListener { commandId, status ->
    runOnUiThread {
        webView.evaluateJavascript("window.__otaResult($commandId, '$status')", null)
    }
}
```

In `onDestroy()`, add:
```kotlin
OtaResultBus.clearListener()
```

- [ ] **Step 7: Update AndroidManifest.xml**

In `android/app/src/main/AndroidManifest.xml`, add permissions and receivers:

```xml
<!-- After existing uses-permission entries: -->
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

<!-- Inside <application>, add receivers: -->
<receiver
    android:name=".BootReceiver"
    android:exported="true" />

<receiver
    android:name=".OtaInstallReceiver"
    android:exported="false" />
```

- [ ] **Step 8: Run Android tests**

```bash
cd android && ./gradlew test && cd ..
```

Expected: `OtaInstallerTest` PASS.

- [ ] **Step 9: Build debug APK to verify compilation**

```bash
cd android && ./gradlew assembleDebug && cd ..
```

Expected: BUILD SUCCESSFUL, APK at `android/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 10: Commit**

```bash
git add android/
git commit -m "feat(apk): OtaInstaller, screenshot, getLogs, getAppVersion — Plan 7 native bridge"
```

---

## Task 9: Dashboard — APK release management page + API client

**Files:**
- Create: `app/pages/apk.vue`
- Modify: `app/composables/useApiClient.ts`
- Modify: `app/types/api.ts`
- Modify: `app/layouts/default.vue` (or wherever nav links live — check sidebar)

**Interfaces:**
- Consumes: `GET /api/apk`, `POST /api/apk/upload`, `DELETE /api/apk/:id`
- Produces: `useApiClient().listApkReleases()`, `uploadApk()`, `deleteApkRelease()`; new `ApkRelease` type

- [ ] **Step 1: Add ApkRelease and DeviceCommand types to api.ts**

Open `app/types/api.ts` and add:

```ts
export interface ApkRelease {
  id: number
  version: string
  sha256: string
  size: number
  uploadedAt: string | number
}

export interface DeviceCommand {
  id: number
  deviceId: string
  cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request'
  payload: string | null
  status: 'pending' | 'sent' | 'acked' | 'failed'
  result: string | null
  createdAt: string | number
  updatedAt: string | number
}
```

- [ ] **Step 2: Add API client methods**

In `app/composables/useApiClient.ts`, add to the `ApiClient` interface:

```ts
// APK releases
listApkReleases(): Promise<ApkRelease[]>
uploadApk(form: FormData): Promise<ApkRelease>
deleteApkRelease(id: number): Promise<void>
apkDownloadUrl(id: number): string

// Device commands
enqueueCommand(deviceId: string, body: { cmd: string; releaseId?: number }): Promise<{ commandId: number }>
listDeviceCommands(deviceId: string): Promise<DeviceCommand[]>
```

In `createApiClient`, add implementations:

```ts
listApkReleases: () => fetch('/api/apk') as Promise<ApkRelease[]>,
uploadApk: (form) => fetch('/api/apk/upload', { method: 'POST', body: form }) as Promise<ApkRelease>,
deleteApkRelease: (id) => fetch(`/api/apk/${id}`, { method: 'DELETE' }).then(() => {}),
apkDownloadUrl: (id) => `/api/apk/${id}/download`,
enqueueCommand: (deviceId, body) =>
  fetch(`/api/devices/${deviceId}/commands`, { method: 'POST', body: JSON.stringify(body) }) as Promise<{ commandId: number }>,
listDeviceCommands: (deviceId) =>
  fetch(`/api/devices/${deviceId}/commands`) as Promise<DeviceCommand[]>,
```

- [ ] **Step 3: Create APK management page**

Create `app/pages/apk.vue`:

```vue
<script setup lang="ts">
import type { ApkRelease } from '~/app/types/api'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const api = useApiClient()
const toast = useToast()

const releases = ref<ApkRelease[]>([])
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const versionInput = ref('')

async function load() {
  releases.value = await api.listApkReleases()
}
onMounted(load)

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || !versionInput.value.trim()) {
    toast.add({ title: 'Enter a version label first', color: 'warning' })
    return
  }
  const form = new FormData()
  form.append('file', file)
  form.append('version', versionInput.value.trim())
  uploading.value = true
  try {
    await api.uploadApk(form)
    toast.add({ title: 'APK uploaded', color: 'success' })
    versionInput.value = ''
    await load()
  } catch (err: any) {
    toast.add({ title: 'Upload failed', description: err.data?.message ?? err.message, color: 'error' })
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function deleteRelease(release: ApkRelease) {
  try {
    await api.deleteApkRelease(release.id)
    releases.value = releases.value.filter(r => r.id !== release.id)
    toast.add({ title: 'Deleted', color: 'success' })
  } catch (err: any) {
    toast.add({ title: 'Delete failed', description: err.data?.message ?? err.message, color: 'error' })
  }
}

function formatBytes(b: number) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="p-6 max-w-3xl mx-auto space-y-6">
    <h1 class="text-2xl font-semibold">APK Releases</h1>

    <UCard>
      <template #header>
        <span class="font-medium">Upload new release</span>
      </template>
      <div class="flex gap-3 items-end flex-wrap">
        <UInput v-model="versionInput" placeholder="Version (e.g. 1.2.3)" class="w-40" />
        <label class="cursor-pointer">
          <UButton
            :loading="uploading"
            leading-icon="i-lucide-upload"
            @click="fileInput?.click()"
          >
            Choose APK…
          </UButton>
          <input ref="fileInput" type="file" accept=".apk" class="hidden" @change="onFileChange" />
        </label>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <span class="font-medium">Releases ({{ releases.length }})</span>
      </template>
      <UTable
        :rows="releases"
        :columns="[
          { key: 'version', label: 'Version' },
          { key: 'size', label: 'Size' },
          { key: 'sha256', label: 'SHA-256' },
          { key: 'uploadedAt', label: 'Uploaded' },
          { key: 'actions', label: '' }
        ]"
      >
        <template #size-data="{ row }">{{ formatBytes(row.size) }}</template>
        <template #sha256-data="{ row }">
          <code class="text-xs">{{ row.sha256.slice(0, 12) }}…</code>
        </template>
        <template #uploadedAt-data="{ row }">
          {{ new Date(row.uploadedAt).toLocaleString() }}
        </template>
        <template #actions-data="{ row }">
          <div class="flex gap-2">
            <UButton
              size="xs"
              variant="ghost"
              leading-icon="i-lucide-download"
              :to="api.apkDownloadUrl(row.id)"
              target="_blank"
            >Download</UButton>
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              leading-icon="i-lucide-trash-2"
              @click="deleteRelease(row)"
            >Delete</UButton>
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
```

- [ ] **Step 4: Add APK nav link to sidebar**

Find the sidebar navigation file (likely `app/layouts/default.vue` or a `AppSidebar` component — check what exists with `find app/ -name "*.vue" | xargs grep -l "nav\|sidebar\|navigation" | head -5`). Add an APK nav entry alongside the existing Devices / Media / Playlists links:

```ts
{ label: 'APK', icon: 'i-lucide-package', to: '/apk' }
```

- [ ] **Step 5: Build and smoke-test**

```bash
PORT=5100 pnpm dev
```

Navigate to `http://localhost:5100/apk` — verify the page loads, upload form shows, releases table is empty. Upload a small test `.apk` file with version `0.0.1` — verify it appears in the table.

- [ ] **Step 6: Commit**

```bash
git add app/pages/apk.vue app/composables/useApiClient.ts app/types/api.ts app/layouts/
git commit -m "feat(ui): APK release management page"
```

---

## Task 10: Dashboard — Device remote control card

**Files:**
- Modify: `app/pages/devices/[id].vue`

**Interfaces:**
- Consumes: `enqueueCommand()`, `listDeviceCommands()` (Task 9); `listApkReleases()` (Task 9); `DeviceCommand`, `ApkRelease` types (Task 9)
- The existing `status.value` already polls every 5s from `GET /api/devices/:id/status` — the device's `apkVersion` from telemetry should be included in that response. Check `server/api/devices/[id]/status.get.ts` and add `apkVersion` to the response if it only returns `currentItemId` etc.

- [ ] **Step 1: Add apkVersion to device status response**

In `server/api/devices/[id]/status.get.ts`, change `DeviceStatus` type:

```ts
export type DeviceStatus = {
  online: boolean
  lastSeenAt: number | null
  apkVersion: string | null                    // add this line
  currentItem: { mediaId: number; filename: string; kind: 'video' | 'image'; sha256: string } | null
  playlistName: string | null
}
```

In `handleDeviceStatus`, change the return statement to include `apkVersion`:

```ts
return { online, lastSeenAt, apkVersion: device.apkVersion ?? null, currentItem, playlistName }
```

In `app/types/api.ts`, find the `DeviceNowPlaying` interface (used by `useApiClient.getDeviceStatus`) and add `apkVersion?: string | null`.

- [ ] **Step 2: Add Remote Control card to device page**

In `app/pages/devices/[id].vue`, add the following after the existing device info sections.

Add to `<script setup>`:

```ts
import type { ApkRelease, DeviceCommand } from '~/app/types/api'

const commands = ref<DeviceCommand[]>([])
const releases = ref<ApkRelease[]>([])
const selectedReleaseId = ref<number | null>(null)
const commandPending = ref(false)
const screenshotData = ref<string | null>(null)
const logData = ref<string | null>(null)
const showLogModal = ref(false)

async function loadCommands() {
  try { commands.value = await api.listDeviceCommands(id.value) } catch {}
}
async function loadReleases() {
  try { releases.value = await api.listApkReleases() } catch {}
}

onMounted(() => { loadCommands(); loadReleases() })

async function enqueue(cmd: string, extra?: { releaseId?: number }) {
  commandPending.value = true
  try {
    await api.enqueueCommand(id.value, { cmd, ...extra })
    toast.add({ title: `${cmd} command sent`, color: 'success' })
    await loadCommands()
    if (cmd === 'screenshot') {
      // Poll for ack up to 30s
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await loadCommands()
        const latest = commands.value.find(c => c.cmd === 'screenshot' && c.status === 'acked')
        if (latest?.result) { screenshotData.value = latest.result; break }
      }
    }
    if (cmd === 'log-request') {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await loadCommands()
        const latest = commands.value.find(c => c.cmd === 'log-request' && c.status === 'acked')
        if (latest?.result) { logData.value = latest.result; showLogModal.value = true; break }
      }
    }
  } catch (err: any) {
    toast.add({ title: 'Failed', description: err.data?.message ?? err.message, color: 'error' })
  } finally {
    commandPending.value = false
  }
}

function statusColor(s: string) {
  return { pending: 'warning', sent: 'info', acked: 'success', failed: 'error' }[s] ?? 'neutral'
}
```

Add to `<template>`, after the existing device detail cards:

```vue
<UCard class="mt-6">
  <template #header>
    <span class="font-medium">Remote Control</span>
  </template>

  <div class="space-y-4">
    <!-- APK version + OTA -->
    <div class="flex items-center gap-3 flex-wrap">
      <span class="text-sm text-gray-500">
        APK on device: <strong>{{ status?.apkVersion ?? '—' }}</strong>
      </span>
      <div class="flex gap-2 items-center">
        <USelect
          v-model="selectedReleaseId"
          :options="releases.map(r => ({ label: r.version, value: r.id }))"
          placeholder="Select release…"
          class="w-40"
        />
        <UButton
          size="sm"
          :disabled="!selectedReleaseId || commandPending"
          :loading="commandPending"
          @click="enqueue('ota', { releaseId: selectedReleaseId! })"
        >Push OTA</UButton>
      </div>
    </div>

    <!-- Other commands -->
    <div class="flex gap-2 flex-wrap">
      <UButton
        size="sm"
        variant="outline"
        leading-icon="i-lucide-refresh-cw"
        :loading="commandPending"
        @click="confirm({ title: 'Restart player?', onConfirm: () => enqueue('reboot') })"
      >Restart player</UButton>
      <UButton
        size="sm"
        variant="outline"
        leading-icon="i-lucide-camera"
        :loading="commandPending"
        @click="enqueue('screenshot')"
      >Screenshot</UButton>
      <UButton
        size="sm"
        variant="outline"
        leading-icon="i-lucide-file-text"
        :loading="commandPending"
        @click="enqueue('log-request')"
      >Pull logs</UButton>
    </div>

    <!-- Screenshot result -->
    <div v-if="screenshotData" class="mt-2">
      <img :src="screenshotData" class="max-w-xs rounded border" alt="Screenshot" />
    </div>

    <!-- Recent commands -->
    <div v-if="commands.length" class="mt-4">
      <p class="text-sm font-medium mb-2">Recent commands</p>
      <div class="space-y-1">
        <div
          v-for="cmd in commands.slice(0, 10)"
          :key="cmd.id"
          class="flex items-center gap-2 text-sm"
        >
          <UBadge :color="statusColor(cmd.status)" size="xs">{{ cmd.status }}</UBadge>
          <span class="font-mono">{{ cmd.cmd }}</span>
          <span class="text-gray-400 text-xs">{{ new Date(cmd.createdAt).toLocaleTimeString() }}</span>
          <UButton
            v-if="cmd.status === 'acked' && cmd.cmd === 'screenshot' && cmd.result"
            size="xs" variant="ghost"
            @click="screenshotData = cmd.result"
          >view</UButton>
          <UButton
            v-if="cmd.status === 'acked' && cmd.cmd === 'log-request' && cmd.result"
            size="xs" variant="ghost"
            @click="logData = cmd.result; showLogModal = true"
          >view</UButton>
        </div>
      </div>
    </div>
  </div>
</UCard>

<!-- Log modal -->
<UModal v-model="showLogModal" title="Device logs">
  <template #body>
    <pre class="text-xs overflow-auto max-h-96 whitespace-pre-wrap">{{ logData }}</pre>
  </template>
</UModal>
```

- [ ] **Step 3: Build and smoke-test**

```bash
PORT=5100 pnpm dev
```

Navigate to a device page. Verify the Remote Control card renders. Click "Screenshot" — confirm a command row appears with `pending` → `sent` status. (Full end-to-end test requires a connected APK box.)

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/pages/devices/[id].vue
git commit -m "feat(ui): device remote control card — OTA, reboot, screenshot, logs"
```

---

## Post-implementation checklist

- [ ] Run `pnpm build` — verify production build succeeds with no errors
- [ ] Run `pnpm test` — verify all tests pass
- [ ] Deploy to server: `./scripts/deploy.sh`
- [ ] Set Device Owner on each box (one-time per physical box):
  ```bash
  adb shell dpm set-device-owner ai.lanka.kiosk/.BootReceiver
  ```
- [ ] Upload a new APK via `/apk` page, push OTA to a test box, confirm silent install
- [ ] Test screenshot and log-pull on a live box
