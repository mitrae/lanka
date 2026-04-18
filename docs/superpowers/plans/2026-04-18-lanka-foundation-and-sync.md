# Lanka Foundation & Sync Backbone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation of Lanka: a Nuxt 4 server where a fake device can self-register, receive its resolved playlist manifest, subscribe to SSE change events, and stream media files with Range support. No dashboard UI, no player web page, no Docker yet — just the sync backbone, provable via `curl`.

**Architecture:** Nuxt 4 monolith with Nitro API routes. SQLite via `better-sqlite3` + Drizzle ORM. Content-addressed media on local disk behind a `MediaStore` interface. Three-level playlist resolution (Device > Group > Address) implemented as a single SQL `UNION ALL` query. SSE hub keyed by device id.

**Tech Stack:** Node.js 22 LTS, Nuxt 4, TypeScript, Drizzle ORM, better-sqlite3, drizzle-kit, vitest, pino, sharp (added in later plan for thumbnails), pnpm.

**Parent spec:** `docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`

---

## File Structure

```
lanka/
├── nuxt.config.ts                                    # Nuxt config
├── drizzle.config.ts                                 # Drizzle kit config
├── package.json                                      # deps + scripts
├── tsconfig.json                                     # Nuxt-extended
├── vitest.config.ts                                  # vitest config
├── .env.example                                      # DATABASE_URL, MEDIA_DIR, etc.
├── .gitignore                                        # node_modules, .output, data/
├── server/
│   ├── db/
│   │   ├── schema.ts                                 # Drizzle schema: all 6 tables
│   │   ├── client.ts                                 # Singleton DB connection
│   │   └── migrations/                               # drizzle-kit output
│   ├── services/
│   │   ├── media-store.ts                            # interface + LocalDiskStore
│   │   ├── resolver.ts                               # Playlist resolution query
│   │   ├── playlist-version.ts                       # version bump helper
│   │   └── events.ts                                 # SSE hub (device-id → clients)
│   ├── utils/
│   │   └── sha256.ts                                 # stream-hashing helper
│   ├── api/
│   │   ├── devices/
│   │   │   ├── register.post.ts
│   │   │   ├── [id]/manifest.get.ts
│   │   │   ├── [id]/stream.get.ts
│   │   │   └── [id]/telemetry.post.ts
│   │   └── media.post.ts                             # upload (multipart)
│   └── routes/
│       └── media/
│           └── [sha256].get.ts                       # binary serve with Range
├── tests/
│   ├── helpers/
│   │   ├── test-db.ts                                # in-memory SQLite + migrations
│   │   └── fixtures.ts                               # seed helpers
│   ├── services/
│   │   ├── media-store.test.ts
│   │   ├── resolver.test.ts
│   │   ├── playlist-version.test.ts
│   │   └── events.test.ts
│   ├── utils/
│   │   └── sha256.test.ts
│   ├── api/
│   │   ├── devices-register.test.ts
│   │   ├── devices-manifest.test.ts
│   │   ├── devices-stream.test.ts
│   │   ├── devices-telemetry.test.ts
│   │   ├── media-upload.test.ts
│   │   └── media-serve.test.ts
│   └── integration/
│       └── sync-flow.test.ts
└── README.md                                         # dev/test commands
```

**Why this split:** Services are the leaf dependencies and get TDD'd first. API routes compose services — they get integration-style tests using an in-memory DB. The `tests/helpers/` directory isolates test setup from production code so production has no test-only branches.

---

## Task 1: Scaffold Nuxt 4 project

**Files:**
- Create: `package.json`
- Create: `nuxt.config.ts`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialise pnpm project**

Run:
```bash
cd /home/dmytro/PhpstormProjects/lanka
pnpm init
```

Replace generated `package.json` contents with:
```json
{
  "name": "lanka",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build",
    "start": "node .output/server/index.mjs",
    "typecheck": "nuxt typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  },
  "engines": {
    "node": ">=22"
  }
}
```

- [ ] **Step 2: Install Nuxt 4 and core dev tooling**

Run:
```bash
pnpm add nuxt@^4 vue@^3
pnpm add -D typescript @types/node vue-tsc
```

Expected: `pnpm-lock.yaml` created, `node_modules/` populated.

- [ ] **Step 3: Create `nuxt.config.ts`**

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2025-10-01',
  devtools: { enabled: true },
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

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "extends": "./.nuxt/tsconfig.json"
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
.nuxt/
.output/
.env
.env.local
dist/
data/
coverage/
*.log
```

- [ ] **Step 6: Create `.env.example`**

```
DATABASE_URL=file:./data/signage.db
MEDIA_DIR=./data/media
PORT=3000
```

- [ ] **Step 7: Verify dev server boots**

Run:
```bash
pnpm dev
```

Expected: Server listens at `http://localhost:3000`. Ctrl+C to stop.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml nuxt.config.ts tsconfig.json .gitignore .env.example
git commit -m "chore: scaffold Nuxt 4 project"
```

---

## Task 2: Install DB stack + set up Drizzle

**Files:**
- Create: `drizzle.config.ts`
- Create: `server/db/client.ts`
- Modify: `package.json` (via pnpm add)

- [ ] **Step 1: Install Drizzle and SQLite driver**

Run:
```bash
pnpm add drizzle-orm better-sqlite3
pnpm add -D drizzle-kit @types/better-sqlite3
```

Expected: packages added to `package.json`.

- [ ] **Step 2: Create `drizzle.config.ts`**

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: (process.env.DATABASE_URL ?? 'file:./data/signage.db').replace(/^file:/, '')
  }
})
```

- [ ] **Step 3: Create `server/db/client.ts`**

```ts
// server/db/client.ts
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

let _db: BetterSQLite3Database<typeof schema> | null = null
let _sqlite: Database.Database | null = null

export function openDatabase(url: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db
  const path = url.replace(/^file:/, '')
  _sqlite = new Database(path)
  _sqlite.pragma('journal_mode = WAL')
  _sqlite.pragma('foreign_keys = ON')
  _db = drizzle(_sqlite, { schema })
  return _db
}

export function useDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    const config = useRuntimeConfig()
    return openDatabase(config.databaseUrl)
  }
  return _db
}

export function closeDatabase(): void {
  _sqlite?.close()
  _db = null
  _sqlite = null
}
```

- [ ] **Step 4: Create `data/` directory (runtime-only; already gitignored)**

```bash
mkdir -p data/media
```

- [ ] **Step 5: Commit**

```bash
git add drizzle.config.ts server/db/client.ts package.json pnpm-lock.yaml
git commit -m "feat(db): install Drizzle + better-sqlite3, wire up client"
```

---

## Task 3: Define schema and run initial migration

**Files:**
- Create: `server/db/schema.ts`
- Create: `server/db/migrations/0000_*.sql` (drizzle-kit generated)

- [ ] **Step 1: Write the schema**

```ts
// server/db/schema.ts
import { sql, relations } from 'drizzle-orm'
import {
  sqliteTable,
  integer,
  text,
  check,
  uniqueIndex,
  index
} from 'drizzle-orm/sqlite-core'

export const addresses = sqliteTable('addresses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  addressId: integer('address_id')
    .notNull()
    .references(() => addresses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(), // device-generated (Android ID or UUID)
  groupId: integer('group_id').references(() => groups.id, { onDelete: 'set null' }),
  name: text('name'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  playerVersion: text('player_version'),
  currentItemId: integer('current_item_id'), // FK added after playlistItems defined (see below)
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha256: text('sha256').notNull(),
    kind: text('kind', { enum: ['video', 'image'] }).notNull(),
    filename: text('filename').notNull(),
    bytes: integer('bytes').notNull(),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    sha256Idx: uniqueIndex('media_sha256_idx').on(t.sha256)
  })
)

export const playlists = sqliteTable('playlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const playlistItems = sqliteTable(
  'playlist_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    durationMsOverride: integer('duration_ms_override')
  },
  (t) => ({
    posIdx: uniqueIndex('playlist_items_pos_idx').on(t.playlistId, t.position)
  })
)

export const assignments = sqliteTable(
  'assignments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    addressId: integer('address_id').references(() => addresses.id, {
      onDelete: 'cascade'
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    deviceIdx: uniqueIndex('assignments_device_idx').on(t.deviceId),
    groupIdx: uniqueIndex('assignments_group_idx').on(t.groupId),
    addressIdx: uniqueIndex('assignments_address_idx').on(t.addressId),
    exactlyOne: check(
      'assignments_exactly_one_target',
      sql`(("device_id" IS NOT NULL) + ("group_id" IS NOT NULL) + ("address_id" IS NOT NULL)) = 1`
    )
  })
)

// Relations (used by Drizzle query API)
export const addressesRelations = relations(addresses, ({ many }) => ({
  groups: many(groups),
  assignments: many(assignments)
}))
export const groupsRelations = relations(groups, ({ one, many }) => ({
  address: one(addresses, { fields: [groups.addressId], references: [addresses.id] }),
  devices: many(devices),
  assignments: many(assignments)
}))
export const devicesRelations = relations(devices, ({ one, many }) => ({
  group: one(groups, { fields: [devices.groupId], references: [groups.id] }),
  assignments: many(assignments)
}))
export const playlistsRelations = relations(playlists, ({ many }) => ({
  items: many(playlistItems),
  assignments: many(assignments)
}))
export const playlistItemsRelations = relations(playlistItems, ({ one }) => ({
  playlist: one(playlists, {
    fields: [playlistItems.playlistId],
    references: [playlists.id]
  }),
  media: one(media, { fields: [playlistItems.mediaId], references: [media.id] })
}))
export const assignmentsRelations = relations(assignments, ({ one }) => ({
  playlist: one(playlists, {
    fields: [assignments.playlistId],
    references: [playlists.id]
  }),
  device: one(devices, { fields: [assignments.deviceId], references: [devices.id] }),
  group: one(groups, { fields: [assignments.groupId], references: [groups.id] }),
  address: one(addresses, {
    fields: [assignments.addressId],
    references: [addresses.id]
  })
}))
```

Note on `devices.currentItemId`: Drizzle's `references()` creates a forward-declared FK. We add it as a raw `FOREIGN KEY ... ON DELETE SET NULL` in Step 3 by hand-editing the generated SQL because Drizzle doesn't express circular FKs cleanly; alternatively leave without FK and enforce cleanup manually. We leave without FK (simpler; playlist deletion explicitly sets devices.currentItemId = NULL in application code — see playlist delete handler in the next plan).

- [ ] **Step 2: Generate migration**

Run:
```bash
pnpm db:generate
```

Expected: a SQL file appears at `server/db/migrations/0000_<random_name>.sql`. Review that it contains all six tables and the `CHECK` constraint on `assignments`.

- [ ] **Step 3: Apply migration**

Run:
```bash
pnpm db:migrate
```

Expected: `data/signage.db` file is created and populated.

- [ ] **Step 4: Smoke-check the DB**

Run:
```bash
sqlite3 data/signage.db ".tables"
```

Expected output:
```
__drizzle_migrations  groups       playlist_items
addresses             media        playlists
assignments           devices
```

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.ts server/db/migrations/
git commit -m "feat(db): initial schema — addresses, groups, devices, media, playlists, assignments"
```

---

## Task 4: Install vitest + test helpers

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/helpers/test-db.ts`
- Create: `tests/helpers/fixtures.ts`
- Modify: `package.json` (via pnpm add)

- [ ] **Step 1: Install vitest**

Run:
```bash
pnpm add -D vitest @vitest/coverage-v8
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: [],
    pool: 'forks' // better-sqlite3 native module isolates per-worker
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./', import.meta.url))
    }
  }
})
```

- [ ] **Step 3: Create `tests/helpers/test-db.ts`**

This helper creates a fresh in-memory SQLite DB per test and applies the migrations.

```ts
// tests/helpers/test-db.ts
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '~/server/db/schema'

export type TestDb = BetterSQLite3Database<typeof schema>

export function createTestDb(): { db: TestDb; close: () => void } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return {
    db,
    close: () => sqlite.close()
  }
}
```

- [ ] **Step 4: Create `tests/helpers/fixtures.ts`**

```ts
// tests/helpers/fixtures.ts
import type { TestDb } from './test-db'
import * as schema from '~/server/db/schema'

export async function seedAddress(db: TestDb, name = 'Mechnikova clinic') {
  const [row] = await db.insert(schema.addresses).values({ name }).returning()
  return row
}

export async function seedGroup(db: TestDb, addressId: number, name = 'Lobby') {
  const [row] = await db.insert(schema.groups).values({ addressId, name }).returning()
  return row
}

export async function seedDevice(
  db: TestDb,
  opts: { id: string; groupId?: number; name?: string }
) {
  const [row] = await db
    .insert(schema.devices)
    .values({ id: opts.id, groupId: opts.groupId, name: opts.name })
    .returning()
  return row
}

export async function seedMedia(
  db: TestDb,
  opts: {
    sha256: string
    kind: 'video' | 'image'
    filename?: string
    bytes?: number
    durationMs?: number | null
  }
) {
  const [row] = await db
    .insert(schema.media)
    .values({
      sha256: opts.sha256,
      kind: opts.kind,
      filename: opts.filename ?? `${opts.sha256}.bin`,
      bytes: opts.bytes ?? 1024,
      durationMs: opts.durationMs ?? (opts.kind === 'video' ? 15000 : null)
    })
    .returning()
  return row
}

export async function seedPlaylist(
  db: TestDb,
  opts: { name?: string; items?: Array<{ mediaId: number; durationMsOverride?: number }> } = {}
) {
  const [pl] = await db
    .insert(schema.playlists)
    .values({ name: opts.name ?? 'Test' })
    .returning()
  if (opts.items) {
    for (const [i, it] of opts.items.entries()) {
      await db.insert(schema.playlistItems).values({
        playlistId: pl.id,
        mediaId: it.mediaId,
        position: i,
        durationMsOverride: it.durationMsOverride
      })
    }
  }
  return pl
}

export async function assign(
  db: TestDb,
  opts: {
    playlistId: number
    deviceId?: string
    groupId?: number
    addressId?: number
  }
) {
  const [row] = await db
    .insert(schema.assignments)
    .values({
      playlistId: opts.playlistId,
      deviceId: opts.deviceId ?? null,
      groupId: opts.groupId ?? null,
      addressId: opts.addressId ?? null
    })
    .returning()
  return row
}
```

- [ ] **Step 5: Add a smoke test to verify setup**

Create `tests/helpers/test-db.test.ts`:
```ts
// tests/helpers/test-db.test.ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from './test-db'
import * as schema from '~/server/db/schema'

describe('test-db helper', () => {
  it('creates a fresh in-memory DB with all tables', async () => {
    const { db, close } = createTestDb()
    try {
      const addresses = await db.select().from(schema.addresses)
      expect(addresses).toEqual([])
    } finally {
      close()
    }
  })
})
```

- [ ] **Step 6: Run the test**

Run:
```bash
pnpm test
```

Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts tests/helpers/ package.json pnpm-lock.yaml
git commit -m "test: add vitest + in-memory DB helper"
```

---

## Task 5: sha256 stream utility

**Files:**
- Create: `server/utils/sha256.ts`
- Create: `tests/utils/sha256.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/utils/sha256.test.ts
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { sha256Stream, sha256Buffer } from '~/server/utils/sha256'

describe('sha256', () => {
  it('hashes a buffer', () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sha256Buffer(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })

  it('hashes a stream', async () => {
    const stream = Readable.from([Buffer.from('hel'), Buffer.from('lo')])
    expect(await sha256Stream(stream)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/utils/sha256.test.ts
```

Expected: FAIL — `Failed to resolve import "~/server/utils/sha256"`.

- [ ] **Step 3: Implement**

```ts
// server/utils/sha256.ts
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256Stream(stream: Readable): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/utils/sha256.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add server/utils/sha256.ts tests/utils/sha256.test.ts
git commit -m "feat(utils): sha256 buffer + stream helpers"
```

---

## Task 6: MediaStore interface + LocalDiskStore

**Files:**
- Create: `server/services/media-store.ts`
- Create: `tests/services/media-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/media-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { LocalDiskStore } from '~/server/services/media-store'

describe('LocalDiskStore', () => {
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lanka-test-'))
    store = new LocalDiskStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a stream to sha256 path', async () => {
    const sha = 'abc123'
    await store.put(sha, Readable.from([Buffer.from('hello')]))
    expect(existsSync(join(dir, sha))).toBe(true)
    expect(await store.has(sha)).toBe(true)
  })

  it('reports unknown sha as absent', async () => {
    expect(await store.has('missing')).toBe(false)
  })

  it('opens a readable stream by sha', async () => {
    await store.put('def', Readable.from([Buffer.from('world')]))
    const s = store.open('def')
    const chunks: Buffer[] = []
    for await (const chunk of s) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('world')
  })

  it('returns byte length via stat', async () => {
    await store.put('ghi', Readable.from([Buffer.from('12345')]))
    const stat = await store.stat('ghi')
    expect(stat.bytes).toBe(5)
  })

  it('deletes a file', async () => {
    await store.put('jkl', Readable.from([Buffer.from('x')]))
    await store.delete('jkl')
    expect(await store.has('jkl')).toBe(false)
  })

  it('put is atomic (writes to temp then renames)', async () => {
    // Confirm no stray .tmp files remain
    await store.put('mno', Readable.from([Buffer.from('data')]))
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(dir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/services/media-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/services/media-store.ts
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat as fsStat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'

export interface MediaStore {
  put(sha256: string, stream: Readable): Promise<void>
  has(sha256: string): Promise<boolean>
  open(sha256: string): Readable
  stat(sha256: string): Promise<{ bytes: number }>
  delete(sha256: string): Promise<void>
}

export class LocalDiskStore implements MediaStore {
  constructor(private readonly dir: string) {}

  private path(sha: string): string {
    return join(this.dir, sha)
  }

  async put(sha: string, stream: Readable): Promise<void> {
    const final = this.path(sha)
    await mkdir(dirname(final), { recursive: true })
    const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await pipeline(stream, createWriteStream(tmp))
      await rename(tmp, final)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // ignore
      }
      throw err
    }
  }

  async has(sha: string): Promise<boolean> {
    return existsSync(this.path(sha))
  }

  open(sha: string): Readable {
    return createReadStream(this.path(sha))
  }

  async stat(sha: string): Promise<{ bytes: number }> {
    const s = await fsStat(this.path(sha))
    return { bytes: s.size }
  }

  async delete(sha: string): Promise<void> {
    try {
      await unlink(this.path(sha))
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/services/media-store.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add server/services/media-store.ts tests/services/media-store.test.ts
git commit -m "feat(services): MediaStore interface + LocalDiskStore impl"
```

---

## Task 7: Resolver service

**Files:**
- Create: `server/services/resolver.ts`
- Create: `tests/services/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedMedia,
  seedPlaylist
} from '../helpers/fixtures'
import { resolvePlaylistForDevice } from '~/server/services/resolver'

describe('resolvePlaylistForDevice', () => {
  let db: TestDb
  let close: () => void

  beforeEach(async () => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })

  afterEach(() => close())

  it('returns null when no assignment matches', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })

    const result = await resolvePlaylistForDevice(db, 'dev-1')
    expect(result).toBeNull()
  })

  it('resolves to the device-level assignment', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'abc', kind: 'video' })
    const pl = await seedPlaylist(db, { name: 'direct', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: pl.id, level: 'device' })
  })

  it('falls back to group-level when device has none', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { name: 'group', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, groupId: group.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: pl.id, level: 'group' })
  })

  it('falls back to address-level when device and group have none', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { name: 'address', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, addressId: addr.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: pl.id, level: 'address' })
  })

  it('device-level beats group-level when both assigned', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const devPl = await seedPlaylist(db, { name: 'dev', items: [{ mediaId: m.id }] })
    const grpPl = await seedPlaylist(db, { name: 'grp', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: devPl.id, deviceId: 'dev-1' })
    await assign(db, { playlistId: grpPl.id, groupId: group.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: devPl.id, level: 'device' })
  })

  it('group-level beats address-level when both assigned', async () => {
    const addr = await seedAddress(db)
    const group = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: group.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const grpPl = await seedPlaylist(db, { name: 'grp', items: [{ mediaId: m.id }] })
    const addrPl = await seedPlaylist(db, { name: 'addr', items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: grpPl.id, groupId: group.id })
    await assign(db, { playlistId: addrPl.id, addressId: addr.id })

    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toEqual({ playlistId: grpPl.id, level: 'group' })
  })

  it('returns null for unknown device id', async () => {
    const r = await resolvePlaylistForDevice(db, 'does-not-exist')
    expect(r).toBeNull()
  })

  it('returns null for unclaimed device (group_id is null)', async () => {
    await seedDevice(db, { id: 'dev-1' })
    const r = await resolvePlaylistForDevice(db, 'dev-1')
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/services/resolver.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement resolver**

```ts
// server/services/resolver.ts
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../db/schema'

export type ResolvedPlaylist = {
  playlistId: number
  level: 'device' | 'group' | 'address'
}

export async function resolvePlaylistForDevice(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<ResolvedPlaylist | null> {
  const rows = db.all<{ playlist_id: number; level: string }>(sql`
    SELECT playlist_id, 'device' AS level
      FROM assignments
     WHERE device_id = ${deviceId}
    UNION ALL
    SELECT a.playlist_id, 'group' AS level
      FROM assignments a
      JOIN devices d ON d.group_id = a.group_id
     WHERE d.id = ${deviceId}
    UNION ALL
    SELECT a.playlist_id, 'address' AS level
      FROM assignments a
      JOIN groups g  ON g.address_id = a.address_id
      JOIN devices d ON d.group_id   = g.id
     WHERE d.id = ${deviceId}
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  return {
    playlistId: row.playlist_id,
    level: row.level as ResolvedPlaylist['level']
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/services/resolver.test.ts
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add server/services/resolver.ts tests/services/resolver.test.ts
git commit -m "feat(services): resolver — most-specific playlist for a device"
```

---

## Task 8: PlaylistVersion bump helper

**Files:**
- Create: `server/services/playlist-version.ts`
- Create: `tests/services/playlist-version.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/playlist-version.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedPlaylist } from '../helpers/fixtures'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'
import * as schema from '~/server/db/schema'

describe('bumpPlaylistVersion', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('increments version by one', async () => {
    const pl = await seedPlaylist(db, { name: 'x' })
    expect(pl.version).toBe(1)

    await bumpPlaylistVersion(db, pl.id)
    const [after] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))

    expect(after.version).toBe(2)
  })

  it('increments repeatedly', async () => {
    const pl = await seedPlaylist(db)
    await bumpPlaylistVersion(db, pl.id)
    await bumpPlaylistVersion(db, pl.id)
    await bumpPlaylistVersion(db, pl.id)
    const [after] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(after.version).toBe(4)
  })

  it('updates updatedAt', async () => {
    const pl = await seedPlaylist(db)
    const before = pl.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    await bumpPlaylistVersion(db, pl.id)
    const [after] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('throws if playlist does not exist', async () => {
    await expect(bumpPlaylistVersion(db, 9999)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/services/playlist-version.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/services/playlist-version.ts
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

export async function bumpPlaylistVersion(
  db: BetterSQLite3Database<typeof schema>,
  playlistId: number
): Promise<void> {
  const result = await db
    .update(schema.playlists)
    .set({
      version: sql`${schema.playlists.version} + 1`,
      updatedAt: new Date()
    })
    .where(eq(schema.playlists.id, playlistId))
    .returning({ id: schema.playlists.id })

  if (result.length === 0) {
    throw new Error(`Playlist ${playlistId} not found`)
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/services/playlist-version.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/services/playlist-version.ts tests/services/playlist-version.test.ts
git commit -m "feat(services): playlist version bump helper"
```

---

## Task 9: SSE events hub

**Files:**
- Create: `server/services/events.ts`
- Create: `tests/services/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/events.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventsHub } from '~/server/services/events'

describe('EventsHub', () => {
  let hub: EventsHub

  beforeEach(() => {
    hub = new EventsHub()
  })

  it('delivers device-scoped events to subscribed clients', () => {
    const received: Array<{ event: string; data: unknown }> = []
    const unsubscribe = hub.subscribeDevice('dev-1', (event, data) => {
      received.push({ event, data })
    })

    hub.emitDevice('dev-1', 'manifest-changed', { playlistId: 42 })
    expect(received).toEqual([
      { event: 'manifest-changed', data: { playlistId: 42 } }
    ])

    unsubscribe()
  })

  it('does not deliver to clients of other devices', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    hub.subscribeDevice('dev-a', (_e, d) => a.push(d))
    hub.subscribeDevice('dev-b', (_e, d) => b.push(d))

    hub.emitDevice('dev-a', 'manifest-changed', { x: 1 })

    expect(a).toEqual([{ x: 1 }])
    expect(b).toEqual([])
  })

  it('supports multiple subscribers on the same device', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    hub.subscribeDevice('dev-1', (_e, d) => a.push(d))
    hub.subscribeDevice('dev-1', (_e, d) => b.push(d))

    hub.emitDevice('dev-1', 'reload', null)

    expect(a).toEqual([null])
    expect(b).toEqual([null])
  })

  it('unsubscribe removes the listener', () => {
    const received: unknown[] = []
    const unsub = hub.subscribeDevice('dev-1', (_e, d) => received.push(d))
    unsub()
    hub.emitDevice('dev-1', 'manifest-changed', { y: 2 })
    expect(received).toEqual([])
  })

  it('emitAllDevices delivers to every device subscriber', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    hub.subscribeDevice('dev-a', (_e, d) => a.push(d))
    hub.subscribeDevice('dev-b', (_e, d) => b.push(d))

    hub.emitAllDevices('reload', null)

    expect(a).toEqual([null])
    expect(b).toEqual([null])
  })

  it('tracks subscriber count', () => {
    expect(hub.deviceSubscriberCount('dev-1')).toBe(0)
    const u1 = hub.subscribeDevice('dev-1', () => {})
    const u2 = hub.subscribeDevice('dev-1', () => {})
    expect(hub.deviceSubscriberCount('dev-1')).toBe(2)
    u1()
    expect(hub.deviceSubscriberCount('dev-1')).toBe(1)
    u2()
    expect(hub.deviceSubscriberCount('dev-1')).toBe(0)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/services/events.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/services/events.ts
export type EventListener = (event: string, data: unknown) => void

export class EventsHub {
  private deviceListeners = new Map<string, Set<EventListener>>()

  subscribeDevice(deviceId: string, listener: EventListener): () => void {
    let set = this.deviceListeners.get(deviceId)
    if (!set) {
      set = new Set()
      this.deviceListeners.set(deviceId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.deviceListeners.delete(deviceId)
    }
  }

  emitDevice(deviceId: string, event: string, data: unknown): void {
    const set = this.deviceListeners.get(deviceId)
    if (!set) return
    for (const listener of set) listener(event, data)
  }

  emitAllDevices(event: string, data: unknown): void {
    for (const set of this.deviceListeners.values()) {
      for (const listener of set) listener(event, data)
    }
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.deviceListeners.get(deviceId)?.size ?? 0
  }
}

// Singleton for app use. Tests construct their own.
let _hub: EventsHub | null = null
export function useEventsHub(): EventsHub {
  if (!_hub) _hub = new EventsHub()
  return _hub
}

// Test-only reset
export function _resetEventsHub(): void {
  _hub = null
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/services/events.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add server/services/events.ts tests/services/events.test.ts
git commit -m "feat(services): in-process SSE events hub"
```

---

## Task 10: POST /api/devices/register

**Files:**
- Create: `server/api/devices/register.post.ts`
- Create: `tests/api/devices-register.test.ts`

**Testing approach:** The tests exercise the handler module directly, passing a mocked `H3Event`. This avoids booting Nuxt in tests. We extract the business logic into an exported `handleRegister(db, body)` function that the HTTP wrapper calls. The same pattern repeats for every API route.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/devices-register.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleRegister } from '~/server/api/devices/register.post'
import * as schema from '~/server/db/schema'

describe('POST /api/devices/register handler', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('creates a new unclaimed device row on first call', async () => {
    const result = await handleRegister(db, {
      deviceId: 'dev-abc',
      playerVersion: '0.1.0'
    })
    expect(result).toEqual({
      deviceId: 'dev-abc',
      claimed: false,
      name: null,
      groupId: null
    })

    const [row] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-abc'))
    expect(row.playerVersion).toBe('0.1.0')
    expect(row.groupId).toBeNull()
    expect(row.lastSeenAt).toBeInstanceOf(Date)
  })

  it('is idempotent — second call updates lastSeenAt + playerVersion', async () => {
    await handleRegister(db, { deviceId: 'dev-abc', playerVersion: '0.1.0' })
    await new Promise((r) => setTimeout(r, 10))
    await handleRegister(db, { deviceId: 'dev-abc', playerVersion: '0.2.0' })

    const [row] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-abc'))
    expect(row.playerVersion).toBe('0.2.0')
  })

  it('reports claimed: true when device has a groupId', async () => {
    const [addr] = await db
      .insert(schema.addresses)
      .values({ name: 'A' })
      .returning()
    const [grp] = await db
      .insert(schema.groups)
      .values({ addressId: addr.id, name: 'G' })
      .returning()
    await db
      .insert(schema.devices)
      .values({ id: 'dev-claimed', groupId: grp.id, name: 'TV-1' })

    const result = await handleRegister(db, {
      deviceId: 'dev-claimed',
      playerVersion: '0.1.0'
    })
    expect(result.claimed).toBe(true)
    expect(result.name).toBe('TV-1')
    expect(result.groupId).toBe(grp.id)
  })

  it('rejects body with missing deviceId', async () => {
    await expect(
      handleRegister(db, { deviceId: '', playerVersion: '0.1.0' } as any)
    ).rejects.toThrow(/deviceId/)
  })

  it('rejects deviceId longer than 128 chars', async () => {
    const big = 'x'.repeat(129)
    await expect(
      handleRegister(db, { deviceId: big, playerVersion: '0.1.0' })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/api/devices-register.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement handler**

```ts
// server/api/devices/register.post.ts
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const BodySchema = z.object({
  deviceId: z.string().min(1).max(128),
  playerVersion: z.string().min(1).max(64)
})

export type RegisterBody = z.infer<typeof BodySchema>
export type RegisterResult = {
  deviceId: string
  claimed: boolean
  name: string | null
  groupId: number | null
}

export async function handleRegister(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<RegisterResult> {
  const body = BodySchema.parse(rawBody)
  const now = new Date()

  await db
    .insert(schema.devices)
    .values({
      id: body.deviceId,
      playerVersion: body.playerVersion,
      lastSeenAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: schema.devices.id,
      set: {
        playerVersion: body.playerVersion,
        lastSeenAt: now,
        updatedAt: now
      }
    })

  const [row] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, body.deviceId))

  return {
    deviceId: row.id,
    claimed: row.groupId !== null,
    name: row.name,
    groupId: row.groupId
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleRegister(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
```

- [ ] **Step 4: Install zod**

Run:
```bash
pnpm add zod
```

- [ ] **Step 5: Run test — verify it passes**

Run:
```bash
pnpm test tests/api/devices-register.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add server/api/devices/register.post.ts tests/api/devices-register.test.ts package.json pnpm-lock.yaml
git commit -m "feat(api): POST /api/devices/register — idempotent self-registration"
```

---

## Task 11: GET /api/devices/:id/manifest

**Files:**
- Create: `server/api/devices/[id]/manifest.get.ts`
- Create: `tests/api/devices-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/devices-manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedMedia,
  seedPlaylist
} from '../helpers/fixtures'
import { handleManifest } from '~/server/api/devices/[id]/manifest.get'
import * as schema from '~/server/db/schema'

describe('GET /api/devices/:id/manifest handler', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  it('returns null when no assignment resolves (caller sends 204)', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })

    const result = await handleManifest(db, 'dev-1')
    expect(result).toBeNull()
  })

  it('returns the full manifest with items', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'aaa', kind: 'video', durationMs: 15000 })
    const i = await seedMedia(db, { sha256: 'bbb', kind: 'image' })
    const pl = await seedPlaylist(db, {
      name: 'Summer',
      items: [
        { mediaId: v.id },
        { mediaId: i.id, durationMsOverride: 8000 }
      ]
    })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const result = await handleManifest(db, 'dev-1')
    expect(result).toEqual({
      playlistId: pl.id,
      playlistName: 'Summer',
      version: 1,
      items: [
        { id: expect.any(Number), type: 'video', sha256: 'aaa', durationMs: 15000 },
        { id: expect.any(Number), type: 'image', sha256: 'bbb', durationMs: 8000 }
      ]
    })
  })

  it('items appear in position order', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const a = await seedMedia(db, { sha256: 'a', kind: 'image' })
    const b = await seedMedia(db, { sha256: 'b', kind: 'image' })
    const c = await seedMedia(db, { sha256: 'c', kind: 'image' })
    const pl = await seedPlaylist(db, {
      items: [
        { mediaId: a.id, durationMsOverride: 1000 },
        { mediaId: b.id, durationMsOverride: 2000 },
        { mediaId: c.id, durationMsOverride: 3000 }
      ]
    })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const r = await handleManifest(db, 'dev-1')
    expect(r?.items.map((i) => i.sha256)).toEqual(['a', 'b', 'c'])
  })

  it('updates lastSeenAt on call', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })

    const before = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()

    await handleManifest(db, 'dev-1')

    const after = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()

    expect(after!.ls).toBeInstanceOf(Date)
    expect(before?.ls ?? null).not.toEqual(after!.ls)
  })

  it('throws 404-style error for unknown device', async () => {
    await expect(handleManifest(db, 'unknown-device')).rejects.toThrow(/unknown/i)
  })

  it('uses duration_ms_override for images, native duration for videos', async () => {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const v = await seedMedia(db, { sha256: 'v', kind: 'video', durationMs: 15000 })
    const i = await seedMedia(db, { sha256: 'i', kind: 'image' })
    const pl = await seedPlaylist(db, {
      items: [
        { mediaId: v.id, durationMsOverride: 9999 }, // video: override ignored
        { mediaId: i.id, durationMsOverride: 7000 }
      ]
    })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })

    const r = await handleManifest(db, 'dev-1')
    expect(r?.items[0].durationMs).toBe(15000) // video native
    expect(r?.items[1].durationMs).toBe(7000) // image override
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/api/devices-manifest.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement handler**

```ts
// server/api/devices/[id]/manifest.get.ts
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { resolvePlaylistForDevice } from '~/server/services/resolver'

export type ManifestItem = {
  id: number
  type: 'video' | 'image'
  sha256: string
  durationMs: number
}

export type Manifest = {
  playlistId: number
  playlistName: string
  version: number
  items: ManifestItem[]
}

export async function handleManifest(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<Manifest | null> {
  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))

  if (!device) {
    throw createError({ statusCode: 404, message: `Unknown device: ${deviceId}` })
  }

  // heartbeat
  await db
    .update(schema.devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.devices.id, deviceId))

  const resolved = await resolvePlaylistForDevice(db, deviceId)
  if (!resolved) return null

  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, resolved.playlistId))

  const items = await db
    .select({
      id: schema.playlistItems.id,
      position: schema.playlistItems.position,
      durationMsOverride: schema.playlistItems.durationMsOverride,
      mediaKind: schema.media.kind,
      mediaSha: schema.media.sha256,
      mediaDur: schema.media.durationMs
    })
    .from(schema.playlistItems)
    .innerJoin(schema.media, eq(schema.media.id, schema.playlistItems.mediaId))
    .where(eq(schema.playlistItems.playlistId, resolved.playlistId))
    .orderBy(asc(schema.playlistItems.position))

  return {
    playlistId: pl.id,
    playlistName: pl.name,
    version: pl.version,
    items: items.map((r) => ({
      id: r.id,
      type: r.mediaKind as 'video' | 'image',
      sha256: r.mediaSha,
      durationMs:
        r.mediaKind === 'video' ? (r.mediaDur ?? 0) : (r.durationMsOverride ?? 0)
    }))
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  const manifest = await handleManifest(useDb(), id)
  if (!manifest) {
    setResponseStatus(event, 204)
    return null
  }
  return manifest
})
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/api/devices-manifest.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/[id]/manifest.get.ts tests/api/devices-manifest.test.ts
git commit -m "feat(api): GET /api/devices/:id/manifest — resolved playlist + heartbeat"
```

---

## Task 12: POST /api/devices/:id/telemetry

**Files:**
- Create: `server/api/devices/[id]/telemetry.post.ts`
- Create: `tests/api/devices-telemetry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/devices-telemetry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  assign,
  seedAddress,
  seedDevice,
  seedGroup,
  seedMedia,
  seedPlaylist
} from '../helpers/fixtures'
import { handleTelemetry } from '~/server/api/devices/[id]/telemetry.post'
import * as schema from '~/server/db/schema'

describe('POST /api/devices/:id/telemetry handler', () => {
  let db: TestDb
  let close: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => close())

  async function setup() {
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    await seedDevice(db, { id: 'dev-1', groupId: grp.id })
    const m = await seedMedia(db, { sha256: 'a', kind: 'video' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'dev-1' })
    const [item] = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, pl.id))
    return { item }
  }

  it('updates currentItemId', async () => {
    const { item } = await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: item.id })
    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    expect(dev.currentItemId).toBe(item.id)
  })

  it('accepts null currentItemId (e.g. no content state)', async () => {
    await setup()
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const [dev] = await db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
    expect(dev.currentItemId).toBeNull()
  })

  it('updates lastSeenAt', async () => {
    await setup()
    const beforeRow = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()
    await new Promise((r) => setTimeout(r, 10))
    await handleTelemetry(db, 'dev-1', { currentItemId: null })
    const afterRow = await db
      .select({ ls: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, 'dev-1'))
      .get()
    expect(afterRow!.ls!.getTime()).toBeGreaterThan(beforeRow!.ls?.getTime() ?? 0)
  })

  it('404s on unknown device', async () => {
    await expect(
      handleTelemetry(db, 'ghost', { currentItemId: null })
    ).rejects.toThrow(/unknown/i)
  })

  it('rejects currentItemId that references an unknown playlist_item', async () => {
    await setup()
    await expect(
      handleTelemetry(db, 'dev-1', { currentItemId: 99999 })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/api/devices-telemetry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/api/devices/[id]/telemetry.post.ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const BodySchema = z.object({
  currentItemId: z.number().int().positive().nullable(),
  error: z
    .object({ sha256: z.string().optional(), message: z.string().max(500) })
    .optional()
})

export type TelemetryBody = z.infer<typeof BodySchema>

export async function handleTelemetry(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string,
  rawBody: unknown
): Promise<void> {
  const body = BodySchema.parse(rawBody)

  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
  if (!device) {
    throw createError({ statusCode: 404, message: `Unknown device: ${deviceId}` })
  }

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
  }

  await db
    .update(schema.devices)
    .set({
      currentItemId: body.currentItemId,
      lastSeenAt: new Date()
    })
    .where(eq(schema.devices.id, deviceId))

  // Playback errors are logged for now; a dedicated errors table can be added later.
  if (body.error) {
    console.warn('[telemetry]', { deviceId, error: body.error })
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  const body = await readBody(event)
  try {
    await handleTelemetry(useDb(), id, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/api/devices-telemetry.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add server/api/devices/[id]/telemetry.post.ts tests/api/devices-telemetry.test.ts
git commit -m "feat(api): POST /api/devices/:id/telemetry"
```

---

## Task 13: GET /api/devices/:id/stream (SSE)

**Files:**
- Create: `server/api/devices/[id]/stream.get.ts`
- Create: `tests/api/devices-stream.test.ts`

**Testing approach:** SSE handler behavior is decomposed into a testable function `createDeviceEventSource(hub, deviceId)` that returns an object with: `subscribe(onMessage)`, `close()`. The Nitro wrapper pipes its output to h3's `createEventStream`. We unit-test the decomposition; Nuxt's event stream handling is assumed to work.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/devices-stream.test.ts
import { describe, it, expect } from 'vitest'
import { EventsHub } from '~/server/services/events'
import { createDeviceEventSource } from '~/server/api/devices/[id]/stream.get'

describe('createDeviceEventSource', () => {
  it('forwards events for the specified device', () => {
    const hub = new EventsHub()
    const received: Array<{ event: string; data: unknown }> = []
    const src = createDeviceEventSource(hub, 'dev-1')
    src.subscribe((event, data) => received.push({ event, data }))

    hub.emitDevice('dev-1', 'manifest-changed', { playlistId: 1 })
    hub.emitDevice('dev-2', 'manifest-changed', { playlistId: 2 })
    hub.emitAllDevices('reload', null)

    expect(received).toEqual([
      { event: 'manifest-changed', data: { playlistId: 1 } },
      { event: 'reload', data: null }
    ])
    src.close()
  })

  it('close() unsubscribes from the hub', () => {
    const hub = new EventsHub()
    const received: unknown[] = []
    const src = createDeviceEventSource(hub, 'dev-1')
    src.subscribe((_e, d) => received.push(d))
    src.close()
    hub.emitDevice('dev-1', 'manifest-changed', { x: 1 })
    expect(received).toEqual([])
    expect(hub.deviceSubscriberCount('dev-1')).toBe(0)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/api/devices-stream.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/api/devices/[id]/stream.get.ts
import type { EventsHub } from '~/server/services/events'
import { useEventsHub } from '~/server/services/events'

export type DeviceEventSource = {
  subscribe: (fn: (event: string, data: unknown) => void) => void
  close: () => void
}

export function createDeviceEventSource(
  hub: EventsHub,
  deviceId: string
): DeviceEventSource {
  let unsubscribe: (() => void) | null = null
  let handler: ((event: string, data: unknown) => void) | null = null

  return {
    subscribe(fn) {
      handler = fn
      unsubscribe = hub.subscribeDevice(deviceId, (event, data) => {
        handler?.(event, data)
      })
    },
    close() {
      unsubscribe?.()
      unsubscribe = null
      handler = null
    }
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })

  const eventStream = createEventStream(event)
  const src = createDeviceEventSource(useEventsHub(), id)

  src.subscribe((name, data) => {
    void eventStream.push({ event: name, data: JSON.stringify(data ?? null) })
  })

  // keep-alive ping every 20s
  const pingInterval = setInterval(() => {
    void eventStream.push({ event: 'ping', data: '{}' })
  }, 20_000)

  eventStream.onClosed(() => {
    clearInterval(pingInterval)
    src.close()
  })

  return eventStream.send()
})
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
pnpm test tests/api/devices-stream.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Smoke-test via curl**

Terminal A:
```bash
pnpm dev
```

Terminal B:
```bash
curl -N http://localhost:3000/api/devices/dev-smoke/stream
```

Expected: connection stays open; every 20s a `ping` event arrives.

- [ ] **Step 6: Commit**

```bash
git add server/api/devices/[id]/stream.get.ts tests/api/devices-stream.test.ts
git commit -m "feat(api): GET /api/devices/:id/stream — SSE with keep-alive pings"
```

---

## Task 14: POST /api/media (multipart upload)

**Files:**
- Create: `server/api/media.post.ts`
- Create: `tests/api/media-upload.test.ts`

- [ ] **Step 1: Install formidable for multipart parsing**

Run:
```bash
pnpm add formidable
pnpm add -D @types/formidable
```

- [ ] **Step 2: Write the failing test**

The handler is factored so that raw bytes → media row is unit-testable (multipart parsing is h3's responsibility). We test `ingestMedia(db, store, { stream, filename, kind })`.

```ts
// tests/api/media-upload.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { ingestMedia } from '~/server/api/media.post'
import * as schema from '~/server/db/schema'

describe('ingestMedia', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-test-'))
    store = new LocalDiskStore(dir)
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  function readable(text: string) {
    return Readable.from([Buffer.from(text)])
  }

  it('stores a new image and creates a media row', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('PNG-BYTES'),
      filename: 'test.png',
      kind: 'image'
    })
    expect(row.sha256).toBe(
      '5ccfb63d9bfdb05ad74a66c2b89d27c8b7d49ccd5f4ed164ca8ba5c28cc3f21f'
    )
    expect(row.kind).toBe('image')
    expect(row.filename).toBe('test.png')
    expect(row.bytes).toBe(9)
    expect(await store.has(row.sha256)).toBe(true)
  })

  it('dedupes — second upload of same content returns the existing row', async () => {
    const a = await ingestMedia(db, store, {
      stream: readable('SAME'),
      filename: 'a.png',
      kind: 'image'
    })
    const b = await ingestMedia(db, store, {
      stream: readable('SAME'),
      filename: 'b.png',
      kind: 'image'
    })
    expect(b.id).toBe(a.id)
    expect(b.filename).toBe('a.png') // original filename preserved

    const all = await db.select().from(schema.media)
    expect(all).toHaveLength(1)
  })

  it('records duration_ms when given', async () => {
    const row = await ingestMedia(db, store, {
      stream: readable('MP4'),
      filename: 'clip.mp4',
      kind: 'video',
      durationMs: 15000
    })
    expect(row.durationMs).toBe(15000)
  })

  it('rejects empty streams', async () => {
    await expect(
      ingestMedia(db, store, {
        stream: Readable.from([]),
        filename: 'empty.bin',
        kind: 'image'
      })
    ).rejects.toThrow(/empty/i)
  })
})
```

- [ ] **Step 3: Run test — verify it fails**

Run:
```bash
pnpm test tests/api/media-upload.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ingestMedia` + handler**

```ts
// server/api/media.post.ts
import { createHash } from 'node:crypto'
import { mkdtempSync, createReadStream, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { eq } from 'drizzle-orm'
import formidable from 'formidable'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'

export type IngestInput = {
  stream: Readable
  filename: string
  kind: 'video' | 'image'
  durationMs?: number
  width?: number
  height?: number
}

export type IngestedMedia = typeof schema.media.$inferSelect

/**
 * Buffers the stream to a temp file to compute sha256 and byte count, then either:
 * - returns the existing media row if sha256 already present (dedupe), OR
 * - moves the file into the store and inserts a new media row.
 */
export async function ingestMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: IngestInput
): Promise<IngestedMedia> {
  // Tee to temp file while hashing
  const tmpDir = mkdtempSync(join(tmpdir(), 'lanka-ingest-'))
  const tmpPath = join(tmpDir, 'upload.bin')
  const hash = createHash('sha256')
  let bytes = 0

  const out = createWriteStream(tmpPath)
  input.stream.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    bytes += chunk.length
  })
  await pipeline(input.stream, out)

  if (bytes === 0) {
    await rm(tmpDir, { recursive: true, force: true })
    throw createError({ statusCode: 400, message: 'Empty upload' })
  }

  const sha256 = hash.digest('hex')

  const existing = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.sha256, sha256))
    .get()

  if (existing) {
    await rm(tmpDir, { recursive: true, force: true })
    return existing
  }

  await store.put(sha256, createReadStream(tmpPath))
  await rm(tmpDir, { recursive: true, force: true })

  const [row] = await db
    .insert(schema.media)
    .values({
      sha256,
      kind: input.kind,
      filename: input.filename,
      bytes,
      durationMs: input.durationMs ?? null,
      width: input.width ?? null,
      height: input.height ?? null
    })
    .returning()
  return row
}

export default defineEventHandler(async (event) => {
  const form = formidable({ maxFileSize: 500 * 1024 * 1024 }) // 500 MB
  const [fields, files] = await form.parse(event.node.req)

  const file = Array.isArray(files.file) ? files.file[0] : files.file
  if (!file) {
    throw createError({ statusCode: 400, message: 'No "file" field in upload' })
  }
  const kindRaw = Array.isArray(fields.kind) ? fields.kind[0] : fields.kind
  const kind = (kindRaw ?? '') as 'video' | 'image'
  if (kind !== 'video' && kind !== 'image') {
    throw createError({ statusCode: 400, message: 'kind must be "video" or "image"' })
  }

  const durMs = Array.isArray(fields.durationMs)
    ? fields.durationMs[0]
    : fields.durationMs

  const result = await ingestMedia(useDb(), useMediaStore(), {
    stream: createReadStream(file.filepath),
    filename: file.originalFilename ?? 'upload.bin',
    kind,
    durationMs: durMs ? Number(durMs) : undefined
  })

  return result
})
```

- [ ] **Step 5: Create MediaStore singleton**

```ts
// server/services/media-store-singleton.ts
import { LocalDiskStore, type MediaStore } from './media-store'

let _store: MediaStore | null = null

export function useMediaStore(): MediaStore {
  if (!_store) {
    const config = useRuntimeConfig()
    _store = new LocalDiskStore(config.mediaDir)
  }
  return _store
}

export function _setMediaStore(store: MediaStore | null): void {
  _store = store
}
```

- [ ] **Step 6: Run test — verify it passes**

Run:
```bash
pnpm test tests/api/media-upload.test.ts
```

Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add server/api/media.post.ts server/services/media-store-singleton.ts tests/api/media-upload.test.ts package.json pnpm-lock.yaml
git commit -m "feat(api): POST /api/media — multipart upload with sha256 dedupe"
```

---

## Task 15: GET /media/:sha256 (binary serve with Range)

**Files:**
- Create: `server/routes/media/[sha256].get.ts`
- Create: `tests/api/media-serve.test.ts`

- [ ] **Step 1: Write the failing test**

The handler logic that decides status + headers + byte range is factored into `planMediaResponse({ fileBytes, rangeHeader })`. We test that purely; the Nitro wrapper just streams bytes and sets the headers.

```ts
// tests/api/media-serve.test.ts
import { describe, it, expect } from 'vitest'
import { planMediaResponse } from '~/server/routes/media/[sha256].get'

describe('planMediaResponse', () => {
  it('returns 200 with full content when no Range header', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: undefined })
    expect(p).toEqual({
      status: 200,
      start: 0,
      end: 99,
      contentLength: 100,
      contentRange: null
    })
  })

  it('returns 206 with correct byte range for bytes=10-49', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=10-49' })
    expect(p).toEqual({
      status: 206,
      start: 10,
      end: 49,
      contentLength: 40,
      contentRange: 'bytes 10-49/100'
    })
  })

  it('handles open-ended ranges bytes=50-', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=50-' })
    expect(p).toEqual({
      status: 206,
      start: 50,
      end: 99,
      contentLength: 50,
      contentRange: 'bytes 50-99/100'
    })
  })

  it('handles suffix ranges bytes=-20 (last 20 bytes)', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=-20' })
    expect(p).toEqual({
      status: 206,
      start: 80,
      end: 99,
      contentLength: 20,
      contentRange: 'bytes 80-99/100'
    })
  })

  it('clamps end to file size - 1', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=50-999' })
    expect(p.status).toBe(206)
    expect(p.end).toBe(99)
    expect(p.contentLength).toBe(50)
  })

  it('returns 416 when start is beyond file size', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'bytes=200-300' })
    expect(p.status).toBe(416)
  })

  it('returns 416 for malformed Range', () => {
    const p = planMediaResponse({ fileBytes: 100, rangeHeader: 'banana' })
    expect(p.status).toBe(416)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm test tests/api/media-serve.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/routes/media/[sha256].get.ts
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import * as schema from '~/server/db/schema'

export type MediaPlan =
  | {
      status: 200 | 206
      start: number
      end: number // inclusive
      contentLength: number
      contentRange: string | null
    }
  | { status: 416 }

export function planMediaResponse(args: {
  fileBytes: number
  rangeHeader: string | undefined
}): MediaPlan {
  const { fileBytes, rangeHeader } = args
  if (!rangeHeader) {
    return {
      status: 200,
      start: 0,
      end: fileBytes - 1,
      contentLength: fileBytes,
      contentRange: null
    }
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!match) return { status: 416 }

  const [, startStr, endStr] = match
  let start: number
  let end: number

  if (startStr === '' && endStr !== '') {
    // suffix: last N bytes
    const n = Number(endStr)
    if (n <= 0) return { status: 416 }
    start = Math.max(0, fileBytes - n)
    end = fileBytes - 1
  } else if (startStr !== '' && endStr === '') {
    start = Number(startStr)
    end = fileBytes - 1
  } else if (startStr !== '' && endStr !== '') {
    start = Number(startStr)
    end = Math.min(Number(endStr), fileBytes - 1)
  } else {
    return { status: 416 }
  }

  if (start >= fileBytes || start > end) return { status: 416 }

  return {
    status: 206,
    start,
    end,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${fileBytes}`
  }
}

export default defineEventHandler(async (event) => {
  const sha = getRouterParam(event, 'sha256')
  if (!sha) throw createError({ statusCode: 400 })

  const db = useDb()
  const [row] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.sha256, sha))
  if (!row) throw createError({ statusCode: 404 })

  const store = useMediaStore()
  if (!(await store.has(sha))) throw createError({ statusCode: 404 })

  const plan = planMediaResponse({
    fileBytes: row.bytes,
    rangeHeader: getRequestHeader(event, 'range')
  })

  setResponseHeader(event, 'Accept-Ranges', 'bytes')
  setResponseHeader(
    event,
    'Content-Type',
    row.kind === 'video' ? 'video/mp4' : 'application/octet-stream'
  )
  setResponseHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')

  if (plan.status === 416) {
    setResponseHeader(event, 'Content-Range', `bytes */${row.bytes}`)
    setResponseStatus(event, 416)
    return null
  }

  setResponseHeader(event, 'Content-Length', String(plan.contentLength))
  if (plan.contentRange) {
    setResponseHeader(event, 'Content-Range', plan.contentRange)
  }
  setResponseStatus(event, plan.status)

  const stream = (store.open as any)(sha, { start: plan.start, end: plan.end })
  // Fallback: if store.open doesn't accept ranges, we fall back to reading full + slicing.
  // LocalDiskStore's open returns createReadStream which accepts {start,end}.
  return sendStream(event, stream)
})
```

Note: the `LocalDiskStore.open` signature currently doesn't accept range options. Update `media-store.ts` to support it.

- [ ] **Step 4: Update LocalDiskStore.open to support ranges**

Edit `server/services/media-store.ts` — change `open` signature:

```ts
// in MediaStore interface:
  open(sha256: string, opts?: { start?: number; end?: number }): Readable

// in LocalDiskStore:
  open(sha: string, opts?: { start?: number; end?: number }): Readable {
    return createReadStream(this.path(sha), opts)
  }
```

- [ ] **Step 5: Update media-store.test.ts to cover the ranged read**

Append to `tests/services/media-store.test.ts`:

```ts
  it('opens a ranged stream', async () => {
    await store.put('rng', Readable.from([Buffer.from('0123456789')]))
    const s = store.open('rng', { start: 2, end: 5 })
    const chunks: Buffer[] = []
    for await (const c of s) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('2345')
  })
```

- [ ] **Step 6: Run all tests — verify pass**

Run:
```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 7: Smoke-test with curl**

Terminal A:
```bash
pnpm dev
```

Terminal B — upload a test file:
```bash
echo -n "hello-world" > /tmp/lanka-test.bin
curl -F "file=@/tmp/lanka-test.bin" -F "kind=image" http://localhost:3000/api/media
```
Returns JSON with `sha256` (e.g. `93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588`).

Then:
```bash
SHA=93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588
curl -v http://localhost:3000/media/$SHA
# Expected: 200, body "hello-world", Accept-Ranges header present

curl -v -H "Range: bytes=2-6" http://localhost:3000/media/$SHA
# Expected: 206, body "llo-w", Content-Range: bytes 2-6/11
```

- [ ] **Step 8: Commit**

```bash
git add server/routes/media/[sha256].get.ts server/services/media-store.ts tests/api/media-serve.test.ts tests/services/media-store.test.ts
git commit -m "feat(api): GET /media/:sha256 with Range support"
```

---

## Task 16: Integration smoke test — full sync flow

**Files:**
- Create: `tests/integration/sync-flow.test.ts`

This is a pure integration test that exercises the handlers end-to-end through an in-memory DB + temp media store. No Nuxt dev server required.

- [ ] **Step 1: Write the test**

```ts
// tests/integration/sync-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleRegister } from '~/server/api/devices/register.post'
import { handleManifest } from '~/server/api/devices/[id]/manifest.get'
import { ingestMedia } from '~/server/api/media.post'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'
import * as schema from '~/server/db/schema'

describe('sync flow end-to-end', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-int-'))
    store = new LocalDiskStore(dir)
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('device registers → gets null manifest → admin creates content → device gets manifest', async () => {
    // 1. Device self-registers
    const reg = await handleRegister(db, {
      deviceId: 'tv-1',
      playerVersion: '0.1.0'
    })
    expect(reg.claimed).toBe(false)

    // 2. Still unclaimed, manifest is null
    const m0 = await handleManifest(db, 'tv-1')
    expect(m0).toBeNull()

    // 3. Admin creates address + group, moves device into group
    const [addr] = await db.insert(schema.addresses).values({ name: 'Clinic' }).returning()
    const [grp] = await db
      .insert(schema.groups)
      .values({ addressId: addr.id, name: 'Lobby' })
      .returning()
    await db
      .update(schema.devices)
      .set({ groupId: grp.id, name: 'TV-Lobby-1' })
      .where(eq(schema.devices.id, 'tv-1'))

    // 4. Admin uploads media
    const v = await ingestMedia(db, store, {
      stream: Readable.from([Buffer.from('video-bytes')]),
      filename: 'promo.mp4',
      kind: 'video',
      durationMs: 15000
    })
    const i = await ingestMedia(db, store, {
      stream: Readable.from([Buffer.from('image-bytes')]),
      filename: 'logo.png',
      kind: 'image'
    })

    // 5. Admin creates playlist + items
    const [pl] = await db.insert(schema.playlists).values({ name: 'Summer' }).returning()
    await db.insert(schema.playlistItems).values([
      { playlistId: pl.id, mediaId: v.id, position: 0 },
      { playlistId: pl.id, mediaId: i.id, position: 1, durationMsOverride: 8000 }
    ])

    // 6. Admin assigns playlist to the group
    await db
      .insert(schema.assignments)
      .values({ playlistId: pl.id, groupId: grp.id })

    // 7. Device polls — now gets manifest via group inheritance
    const m1 = await handleManifest(db, 'tv-1')
    expect(m1).not.toBeNull()
    expect(m1!.playlistId).toBe(pl.id)
    expect(m1!.version).toBe(1)
    expect(m1!.items).toHaveLength(2)
    expect(m1!.items[0]).toMatchObject({
      type: 'video',
      sha256: v.sha256,
      durationMs: 15000
    })
    expect(m1!.items[1]).toMatchObject({
      type: 'image',
      sha256: i.sha256,
      durationMs: 8000
    })

    // 8. Admin edits playlist (bump version)
    await bumpPlaylistVersion(db, pl.id)
    const m2 = await handleManifest(db, 'tv-1')
    expect(m2!.version).toBe(2)

    // 9. Admin creates an override at device level — this wins over group
    const [pl2] = await db
      .insert(schema.playlists)
      .values({ name: 'Override' })
      .returning()
    await db
      .insert(schema.playlistItems)
      .values({ playlistId: pl2.id, mediaId: v.id, position: 0 })
    await db
      .insert(schema.assignments)
      .values({ playlistId: pl2.id, deviceId: 'tv-1' })

    const m3 = await handleManifest(db, 'tv-1')
    expect(m3!.playlistId).toBe(pl2.id) // device-level overrides group-level
  })
})
```

- [ ] **Step 2: Run the test**

Run:
```bash
pnpm test tests/integration/sync-flow.test.ts
```

Expected: 1 passed.

- [ ] **Step 3: Run the full test suite**

Run:
```bash
pnpm test
```

Expected: all tests pass (roughly 35+ tests across all files).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/sync-flow.test.ts
git commit -m "test: end-to-end sync flow integration test"
```

---

## Task 17: README with dev + test commands

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# Lanka

Self-hosted digital signage for Android TVs on a Tailscale tailnet.

**Status:** Foundation & sync backbone only (Plan 1 of 5). No dashboard UI, no player page, no Docker yet — those come in later plans.

## Requirements

- Node.js 22+
- pnpm
- SQLite 3 CLI (optional, for poking at the DB)

## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
```

## Dev

```bash
pnpm dev          # Nuxt dev server on http://localhost:3000
pnpm test         # run full vitest suite
pnpm test:watch   # vitest watch mode
pnpm typecheck    # nuxt typecheck
pnpm db:studio    # Drizzle Studio (DB explorer)
pnpm db:generate  # generate a new migration from schema changes
pnpm db:migrate   # apply migrations to data/signage.db
```

## Current endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/devices/register` | Device self-registration (idempotent) |
| GET  | `/api/devices/:id/manifest` | Device fetches its resolved playlist manifest |
| GET  | `/api/devices/:id/stream` | SSE stream for push events |
| POST | `/api/devices/:id/telemetry` | Device reports current item / errors |
| POST | `/api/media` | Upload a media file (multipart, field name `file`, `kind=video\|image`) |
| GET  | `/media/:sha256` | Serve a media file (supports Range) |

## Project structure

```
server/        Nitro routes, services, DB client & schema
tests/         vitest tests (services, api, integration, helpers)
data/          runtime data (DB + media files) — gitignored
docs/          superpowers specs and plans
```

## Design spec

`docs/superpowers/specs/2026-04-18-lanka-digital-signage-design.md`

## Next plans

1. **Dashboard API & UI** — CRUD for all entities + Nuxt UI admin.
2. **Player web page** — `/player` route with double-buffered playback.
3. **Deployment** — Dockerfile, Compose, systemd, backups.
4. **Android APK** — native kiosk shell.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for foundation milestone"
```

---

## Self-Review Checklist

**Spec coverage:** every item from the spec in scope for Plan 1 maps to a task:
- ✅ Trust model (no auth) — endpoints written without auth middleware
- ✅ Stack choices (Nuxt 4, Drizzle, better-sqlite3, vitest) — Tasks 1–4
- ✅ Six tables with the correct constraints — Task 3
- ✅ MediaStore interface + LocalDiskStore impl — Task 6
- ✅ Resolver query returning playlist_id + level — Task 7
- ✅ PlaylistVersion bump helper — Task 8
- ✅ SSE events hub — Task 9
- ✅ Device API: register, manifest, stream, telemetry — Tasks 10–13
- ✅ Media upload + serve with Range — Tasks 14–15
- ✅ 204 when no assignment — Task 11
- ✅ Integration smoke — Task 16

**Out of scope for Plan 1 (deferred to later plans, intentionally):**
- Dashboard pages and dashboard CRUD APIs (Plan 2)
- `/player` Nuxt page (Plan 3)
- Dashboard SSE stream (`/api/dashboard/stream`) (Plan 2)
- Thumbnails via sharp/ffmpeg — Plan 2 where they surface in the UI
- SSE emission when assignments/playlists change (Plan 2 — requires CRUD handlers to call hub)
- Dockerfile + Compose + systemd (Plan 4)
- Android APK (Plan 5)

**Placeholder scan:** no TBDs, no "add appropriate validation" — every code step contains the exact code.

**Type consistency:** `RegisterResult`, `Manifest`, `ManifestItem`, `ResolvedPlaylist`, `MediaPlan`, `IngestedMedia` — all defined exactly once, referenced consistently. Handler export naming pattern `handle<Name>` used uniformly (`handleRegister`, `handleManifest`, `handleTelemetry`). `defineEventHandler` is the Nitro default export.

**One known caveat in Task 15:** the Nuxt/h3 default `stream.get.ts` handler (Task 13) uses `createEventStream` which is an h3 v1 API — behavior is only exercised manually in Step 5. If the dev smoke fails (unlikely; it's a supported API in the compatibilityDate we chose), fall back to manually writing SSE with `event.node.res.write(...)` using the textbook format.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-lanka-foundation-and-sync.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task with reviews between tasks. Parallelism, context hygiene, faster iteration.

**2. Inline Execution** — Walk through tasks in this session using `superpowers:executing-plans`, with checkpoints for review.

**Which approach?**
