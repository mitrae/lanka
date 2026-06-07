# Lanka Auth + Organizations + Light Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add username/password auth with server sessions and three roles (super/admin/client), a new Organizations entity that owns media, a read-only client "reach" stats portal, and a light "soft-card" theme foundation — without locking the Android fleet out of its device endpoints.

**Architecture:** New `organizations`/`users`/`sessions` tables + `media.organizationId`. Auth is built from Node primitives (`crypto.scrypt` hashing, DB-backed sessions, httpOnly cookie). A single Nitro middleware attaches `event.context.user` and enforces a three-tier route policy (public device endpoints / dashboard / client portal) via a pure, unit-tested `decideAccess` function. Reach stats reuse the existing `resolvePlaylistForDevice` resolver. The theme is re-skinned within Nuxt UI v3 (app.config colors + Tailwind `@theme`), defaulting to light, applied to login/sidebar/Overview/portal this round.

**Tech Stack:** Nuxt 4 (SPA, `ssr:false`) · Nitro/h3 · better-sqlite3 + Drizzle ORM · Nuxt UI v3 + Tailwind v4 · `@nuxt/fonts` · Pinia · Vitest (`pool: 'forks'`) · Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-06-07-lanka-auth-organizations-light-redesign-design.md`

---

## Conventions used throughout

- Server route files export a **pure `handleXxx(db, …)`** function (unit-tested directly) plus a `defineEventHandler` wrapper (does cookies/params/status). Tests import the pure function and call it with `createTestDb()`.
- Tests: `import { createTestDb } from '../helpers/test-db'`, fixtures from `../helpers/fixtures`. Run a single file with `pnpm vitest run tests/<path> -t '<name>'`.
- Dev server: `PORT=5100 pnpm dev` (3xxx is occupied on this machine).
- Commit after every green task.

## File map (what each new/changed file owns)

**Server**
- `server/db/schema.ts` *(modify)* — add `organizations`, `users`, `sessions`, `media.organizationId` + relations.
- `server/db/migrations/0002_*.sql` *(generated)* — the migration.
- `server/services/password.ts` *(new)* — scrypt `hashPassword`/`verifyPassword`.
- `server/services/sessions.ts` *(new)* — session create/lookup/delete + `SessionUser` type + cookie constant.
- `server/services/auth-guard.ts` *(new)* — `isPublicRoute`, `decideAccess`, `requireRole`.
- `server/middleware/auth.ts` *(new)* — attaches user, enforces `decideAccess`.
- `server/services/seed.ts` *(new)* — idempotent `seedInitialUsers`.
- `server/plugins/seed.ts` *(new)* — runs seed on Nitro startup, logs generated passwords.
- `server/api/auth/{login.post,logout.post,me.get}.ts` *(new)*.
- `server/api/organizations/{index.get,index.post}.ts` *(new)*.
- `server/api/media/[id]/organization.put.ts` *(new)* — assign media → org.
- `server/services/reach.ts` *(new)* — `computeOrgReach`.
- `server/api/portal/stats.get.ts` *(new)* — client-scoped reach.
- `server/types/h3.d.ts` *(new)* — augment `H3EventContext.user`.

**App**
- `app/types/api.ts` *(modify)* — add `Role`, `SessionUser`, `Organization`, `MediaReach`, `OrgReach`; add `organizationId` to media types.
- `app/composables/useApiClient.ts` *(modify)* — add auth/org/portal methods.
- `app/stores/auth.ts` *(new)* · `app/stores/organizations.ts` *(new)*.
- `app/middleware/auth.global.ts` *(new)* — client route guard.
- `app/pages/login.vue` *(new)* · `app/layouts/portal.vue` *(new)* · `app/pages/portal/index.vue` *(new)* · `app/pages/organizations/index.vue` *(new)*.
- `app/layouts/default.vue` *(modify)* — restyle + logout + role-aware nav.
- `app/components/StatCard.vue` *(modify)* · `app/components/Donut.vue` *(new)* · `app/pages/index.vue` *(modify)*.
- `app/app.config.ts` *(modify)* · `app/assets/css/main.css` *(modify)* · `nuxt.config.ts` *(modify)*.

**Tests/helpers/config**
- `tests/helpers/fixtures.ts` *(modify)* — `seedOrganization`, `seedUser`.
- `tests/helpers/nuxt-stubs.ts` *(modify)* — cookie stubs.
- Test files per task below.
- `.env.example` *(modify)* — `SEED_*` docs.

---

# Phase A — Data model & migration

### Task 1: Schema + migration + test fixtures

**Files:**
- Modify: `server/db/schema.ts`
- Generate: `server/db/migrations/0002_*.sql`
- Modify: `tests/helpers/fixtures.ts`
- Test: `tests/db/auth-schema.test.ts`

- [ ] **Step 1: Add tables + relations to `server/db/schema.ts`**

Add after the existing `deviceErrors` table (keep existing imports; `check`, `index`, `uniqueIndex` are already imported):

```ts
export const organizations = sqliteTable('organizations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['super', 'admin', 'client'] }).notNull(),
    organizationId: integer('organization_id').references(() => organizations.id, {
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
    usernameIdx: uniqueIndex('users_username_idx').on(t.username),
    roleOrg: check(
      'users_role_org_chk',
      sql`(("role" = 'client' AND "organization_id" IS NOT NULL) OR ("role" IN ('super','admin') AND "organization_id" IS NULL))`
    )
  })
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256(rawCookieToken)
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId)
  })
)
```

Add `organizationId` to the existing `media` table object (inside its column block, before the closing `}`):

```ts
    organizationId: integer('organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' }
    ),
```

Add relations at the bottom (alongside the existing `*Relations` exports):

```ts
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  media: many(media)
}))
export const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id]
  })
}))
export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] })
}))
export const mediaRelations = relations(media, ({ one }) => ({
  organization: one(organizations, {
    fields: [media.organizationId],
    references: [organizations.id]
  })
}))
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/0002_*.sql` is created adding `organizations`, `users`, `sessions`, and `ALTER TABLE media ADD organization_id`. Open it and confirm it contains `CREATE TABLE \`users\``, the `users_role_org_chk` CHECK, `users_username_idx`, and the media alter. (drizzle-kit runs non-interactively for pure additions.)

- [ ] **Step 3: Add fixtures to `tests/helpers/fixtures.ts`**

```ts
export async function seedOrganization(db: TestDb, name = 'Acme Ads') {
  const [row] = await db
    .insert(schema.organizations)
    .values({ name })
    .returning()
  return row
}

export async function seedUser(
  db: TestDb,
  opts: {
    username: string
    role: 'super' | 'admin' | 'client'
    passwordHash?: string
    organizationId?: number | null
  }
) {
  const [row] = await db
    .insert(schema.users)
    .values({
      username: opts.username,
      role: opts.role,
      passwordHash: opts.passwordHash ?? 'scrypt$16384$8$1$x$x',
      organizationId: opts.organizationId ?? null
    })
    .returning()
  return row
}
```

Also extend `seedMedia` to accept an owner: add `organizationId?: number | null` to its `opts` type and pass `organizationId: opts.organizationId ?? null` in the insert values.

- [ ] **Step 4: Write the schema test** `tests/db/auth-schema.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedUser } from '../helpers/fixtures'

describe('auth schema', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates an organization and a client user linked to it', async () => {
    const org = await seedOrganization(db)
    const u = await seedUser(db, { username: 'c1', role: 'client', organizationId: org.id })
    expect(u.role).toBe('client')
    expect(u.organizationId).toBe(org.id)
  })

  it('allows super/admin without an organization', async () => {
    const s = await seedUser(db, { username: 'super', role: 'super' })
    expect(s.organizationId).toBeNull()
  })

  it('rejects a client without an organization (CHECK constraint)', async () => {
    await expect(
      seedUser(db, { username: 'bad', role: 'client', organizationId: null })
    ).rejects.toThrow()
  })

  it('rejects a super WITH an organization (CHECK constraint)', async () => {
    const org = await seedOrganization(db)
    await expect(
      seedUser(db, { username: 'bad2', role: 'super', organizationId: org.id })
    ).rejects.toThrow()
  })

  it('enforces unique usernames', async () => {
    await seedUser(db, { username: 'dup', role: 'admin' })
    await expect(seedUser(db, { username: 'dup', role: 'admin' })).rejects.toThrow()
  })
})
```

- [ ] **Step 5: Run tests** — `pnpm vitest run tests/db/auth-schema.test.ts` → all pass (proves migration + CHECK constraints work).
- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/migrations tests/helpers/fixtures.ts tests/db/auth-schema.test.ts
git commit -m "feat(db): organizations, users, sessions tables + media owner"
```

---

# Phase B — Auth primitives (pure services)

### Task 2: Password hashing (scrypt)

**Files:** Create `server/services/password.ts` · Test `tests/services/password.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '~/server/services/password'

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('hunter2', hash)).toBe(true)
  })
  it('rejects a wrong password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })
  it('produces a self-describing scrypt string with a unique salt', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a.startsWith('scrypt$')).toBe(true)
    expect(a).not.toEqual(b) // random salt
  })
  it('returns false for a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail** (`Cannot find module`). `pnpm vitest run tests/services/password.test.ts`
- [ ] **Step 3: Implement `server/services/password.ts`**

```ts
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  let derived: Buffer
  try {
    derived = (await scryptAsync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr)
    })) as Buffer
  } catch {
    return false
  }
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add server/services/password.ts tests/services/password.test.ts && git commit -m "feat(auth): scrypt password hashing"`

### Task 3: Sessions service

**Files:** Create `server/services/sessions.ts` · Test `tests/services/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import {
  createSession,
  getSessionUser,
  deleteSession,
  SESSION_TTL_MS
} from '~/server/services/sessions'

describe('sessions', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('round-trips a session token to a user', async () => {
    const u = await seedUser(db, { username: 'admin', role: 'admin' })
    const token = await createSession(db, u.id)
    const su = await getSessionUser(db, token)
    expect(su).toMatchObject({ id: u.id, username: 'admin', role: 'admin', organizationId: null })
  })

  it('returns null for an unknown / undefined token', async () => {
    expect(await getSessionUser(db, undefined)).toBeNull()
    expect(await getSessionUser(db, 'nope')).toBeNull()
  })

  it('returns null for an expired session', async () => {
    const u = await seedUser(db, { username: 'a', role: 'admin' })
    const past = new Date(Date.now() - SESSION_TTL_MS - 1000)
    const token = await createSession(db, u.id, past) // expires relative to `past`
    expect(await getSessionUser(db, token)).toBeNull()
  })

  it('deleteSession invalidates the token', async () => {
    const u = await seedUser(db, { username: 'a', role: 'admin' })
    const token = await createSession(db, u.id)
    await deleteSession(db, token)
    expect(await getSessionUser(db, token)).toBeNull()
  })

  it('stores only a hash of the token (raw token absent from the row id)', async () => {
    const u = await seedUser(db, { username: 'a', role: 'admin' })
    const token = await createSession(db, u.id)
    const rows = await db.query.sessions.findMany()
    expect(rows[0].id).not.toEqual(token)
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/services/sessions.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

export const SESSION_COOKIE = 'lanka_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export type Role = 'super' | 'admin' | 'client'
export type SessionUser = {
  id: number
  username: string
  role: Role
  organizationId: number | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  db: BetterSQLite3Database<typeof schema>,
  userId: number,
  now = new Date()
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(schema.sessions).values({
    id: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now
  })
  return token
}

export async function getSessionUser(
  db: BetterSQLite3Database<typeof schema>,
  token: string | undefined,
  now = new Date()
): Promise<SessionUser | null> {
  if (!token) return null
  const [row] = await db
    .select({
      expiresAt: schema.sessions.expiresAt,
      id: schema.users.id,
      username: schema.users.username,
      role: schema.users.role,
      organizationId: schema.users.organizationId
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, hashToken(token)))
  if (!row) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  return {
    id: row.id,
    username: row.username,
    role: row.role as Role,
    organizationId: row.organizationId
  }
}

export async function deleteSession(
  db: BetterSQLite3Database<typeof schema>,
  token: string | undefined
): Promise<void> {
  if (!token) return
  await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)))
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(auth): DB-backed sessions with hashed tokens"`

### Task 4: Auth guard (route classification + role check)

**Files:** Create `server/services/auth-guard.ts` · Create `server/types/h3.d.ts` · Test `tests/services/auth-guard.test.ts`

- [ ] **Step 1: Write the failing test** (this is the safety-critical "device endpoints stay open" test)

```ts
import { describe, it, expect } from 'vitest'
import { isPublicRoute, decideAccess, requireRole } from '~/server/services/auth-guard'
import type { SessionUser } from '~/server/services/sessions'

const admin: SessionUser = { id: 1, username: 'a', role: 'admin', organizationId: null }
const client: SessionUser = { id: 2, username: 'c', role: 'client', organizationId: 9 }

describe('isPublicRoute — device endpoints must stay open', () => {
  const open = [
    '/api/healthz',
    '/api/auth/login',
    '/api/auth/me',
    '/api/devices/register',
    '/api/devices/abc123/manifest',
    '/api/devices/abc123/stream',
    '/api/devices/abc123/telemetry'
  ]
  it.each(open)('treats %s as public', (p) => expect(isPublicRoute(p)).toBe(true))

  const closed = [
    '/api/devices',
    '/api/devices/abc123',
    '/api/devices/abc123/reload',
    '/api/media',
    '/api/dashboard/stream'
  ]
  it.each(closed)('treats %s as protected', (p) => expect(isPublicRoute(p)).toBe(false))
})

describe('decideAccess', () => {
  it('allows public routes with no user', () => {
    expect(decideAccess('/api/devices/x/manifest', null)).toEqual({ ok: true })
  })
  it('allows non-api paths (SPA pages/assets) with no user', () => {
    expect(decideAccess('/login', null)).toEqual({ ok: true })
    expect(decideAccess('/_nuxt/entry.js', null)).toEqual({ ok: true })
  })
  it('401s a protected api route with no user', () => {
    expect(decideAccess('/api/media', null)).toEqual({ ok: false, status: 401 })
  })
  it('403s a client hitting the dashboard tier', () => {
    expect(decideAccess('/api/media', client)).toEqual({ ok: false, status: 403 })
  })
  it('allows admin on the dashboard tier', () => {
    expect(decideAccess('/api/media', admin)).toEqual({ ok: true })
  })
  it('allows client on the portal tier, 403s admin', () => {
    expect(decideAccess('/api/portal/stats', client)).toEqual({ ok: true })
    expect(decideAccess('/api/portal/stats', admin)).toEqual({ ok: false, status: 403 })
  })
})

describe('requireRole', () => {
  it('returns the user when role matches', () => {
    expect(requireRole(admin, ['admin', 'super'])).toBe(admin)
  })
  it('throws 401 when no user', () => {
    expect(() => requireRole(null, ['admin'])).toThrow(/required/i)
  })
  it('throws 403 when role mismatches', () => {
    expect(() => requireRole(client, ['admin', 'super'])).toThrow(/permission/i)
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/services/auth-guard.ts`** (`createError` is a Nitro auto-import, stubbed functional in tests)

```ts
import type { Role, SessionUser } from './sessions'

const PUBLIC_EXACT = new Set<string>(['/api/healthz', '/api/devices/register'])
const PUBLIC_DEVICE_RE = /^\/api\/devices\/[^/]+\/(manifest|stream|telemetry)$/

export function isPublicRoute(path: string): boolean {
  const clean = path.split('?')[0]
  if (PUBLIC_EXACT.has(clean)) return true
  if (clean.startsWith('/api/auth/')) return true
  if (PUBLIC_DEVICE_RE.test(clean)) return true
  return false
}

export type AuthDecision = { ok: true } | { ok: false; status: 401 | 403 }

export function decideAccess(path: string, user: SessionUser | null): AuthDecision {
  const clean = path.split('?')[0]
  if (isPublicRoute(clean)) return { ok: true }
  if (!clean.startsWith('/api/')) return { ok: true } // SPA pages/assets — guarded client-side
  if (!user) return { ok: false, status: 401 }
  if (clean.startsWith('/api/portal/')) {
    return user.role === 'client' ? { ok: true } : { ok: false, status: 403 }
  }
  return user.role === 'admin' || user.role === 'super'
    ? { ok: true }
    : { ok: false, status: 403 }
}

export function requireRole(
  user: SessionUser | null | undefined,
  roles: Role[]
): SessionUser {
  if (!user) throw createError({ statusCode: 401, message: 'Authentication required' })
  if (!roles.includes(user.role)) {
    throw createError({ statusCode: 403, message: 'Insufficient permissions' })
  }
  return user
}
```

- [ ] **Step 4: Create `server/types/h3.d.ts`** (so handlers can read `event.context.user` with types)

```ts
import type { SessionUser } from '~/server/services/sessions'

declare module 'h3' {
  interface H3EventContext {
    user: SessionUser | null
  }
}
export {}
```

- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** — `git add server/services/auth-guard.ts server/types/h3.d.ts tests/services/auth-guard.test.ts && git commit -m "feat(auth): route-tier access policy + requireRole"`

---

# Phase C — Seed

### Task 5: Idempotent seed service

**Files:** Create `server/services/seed.ts` · Test `tests/services/seed.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia } from '../helpers/fixtures'
import { seedInitialUsers } from '~/server/services/seed'
import { verifyPassword } from '~/server/services/password'

describe('seedInitialUsers', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates super, admin, client (+demo org) on first run', async () => {
    const creds = await seedInitialUsers(db, {
      super: 'spw', admin: 'apw', client: 'cpw'
    })
    expect(creds.map((c) => c.role).sort()).toEqual(['admin', 'client', 'super'])
    const users = await db.query.users.findMany()
    expect(users).toHaveLength(3)
    const client = users.find((u) => u.role === 'client')!
    expect(client.organizationId).not.toBeNull()
    expect(await verifyPassword('apw', users.find((u) => u.role === 'admin')!.passwordHash)).toBe(true)
  })

  it('assigns pre-existing unowned media to the demo org', async () => {
    await seedMedia(db, { sha256: 'm1', kind: 'image' })
    await seedInitialUsers(db, { super: 's', admin: 'a', client: 'c' })
    const [org] = await db.query.organizations.findMany()
    const media = await db.query.media.findMany()
    expect(media[0].organizationId).toBe(org.id)
  })

  it('is idempotent: a second run creates nothing and returns []', async () => {
    await seedInitialUsers(db, { super: 's', admin: 'a', client: 'c' })
    const second = await seedInitialUsers(db, { super: 's', admin: 'a', client: 'c' })
    expect(second).toEqual([])
    expect(await db.query.users.findMany()).toHaveLength(3)
  })

  it('generates a random password and flags it when env is missing', async () => {
    const creds = await seedInitialUsers(db, {})
    expect(creds.every((c) => c.generated)).toBe(true)
    expect(creds.every((c) => c.password.length >= 12)).toBe(true)
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/services/seed.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import type { Role } from './sessions'
import { hashPassword } from './password'

export type SeedCredential = {
  username: string
  role: Role
  password: string
  generated: boolean
}

function resolvePassword(envVal: string | undefined): { password: string; generated: boolean } {
  if (envVal && envVal.length > 0) return { password: envVal, generated: false }
  return { password: randomBytes(12).toString('base64url'), generated: true }
}

export async function seedInitialUsers(
  db: BetterSQLite3Database<typeof schema>,
  env: { super?: string; admin?: string; client?: string } = {}
): Promise<SeedCredential[]> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1)
  if (existing.length > 0) return []

  const creds: SeedCredential[] = []

  const su = resolvePassword(env.super)
  await db.insert(schema.users).values({
    username: 'super', role: 'super', passwordHash: await hashPassword(su.password), organizationId: null
  })
  creds.push({ username: 'super', role: 'super', ...su })

  const ad = resolvePassword(env.admin)
  await db.insert(schema.users).values({
    username: 'admin', role: 'admin', passwordHash: await hashPassword(ad.password), organizationId: null
  })
  creds.push({ username: 'admin', role: 'admin', ...ad })

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Demo Organization' })
    .returning()

  const cl = resolvePassword(env.client)
  await db.insert(schema.users).values({
    username: 'client', role: 'client', passwordHash: await hashPassword(cl.password), organizationId: org.id
  })
  creds.push({ username: 'client', role: 'client', ...cl })

  // Give the demo client something to see: adopt all currently-unowned media.
  await db
    .update(schema.media)
    .set({ organizationId: org.id })
    .where(isNull(schema.media.organizationId))

  return creds
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add server/services/seed.ts tests/services/seed.test.ts && git commit -m "feat(auth): idempotent first-run user/org seed"`

### Task 6: Wire seed into Nitro startup

**Files:** Create `server/plugins/seed.ts` · Modify `.env.example`

- [ ] **Step 1: Create `server/plugins/seed.ts`** (`defineNitroPlugin` is a Nitro auto-import; this file is never imported by tests)

```ts
import { useDb } from '~/server/db/client'
import { seedInitialUsers } from '~/server/services/seed'

export default defineNitroPlugin(async () => {
  const creds = await seedInitialUsers(useDb(), {
    super: process.env.SEED_SUPER_PASSWORD,
    admin: process.env.SEED_ADMIN_PASSWORD,
    client: process.env.SEED_CLIENT_PASSWORD
  })
  for (const c of creds) {
    if (c.generated) {
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${c.role} "${c.username}" — generated password: ${c.password}`)
    } else {
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${c.role} "${c.username}" (password from env)`)
    }
  }
})
```

- [ ] **Step 2: Document seed vars in `.env.example`** — append:

```bash
# Initial accounts (seeded on first run only). If unset, a strong random
# password is generated and printed to the server log once.
# SEED_SUPER_PASSWORD=...
# SEED_ADMIN_PASSWORD=...
# SEED_CLIENT_PASSWORD=...
```

- [ ] **Step 3: Manual verify** — delete dev DB so seed runs fresh, then start:

```bash
rm -f data/signage.db data/signage.db-shm data/signage.db-wal
SEED_SUPER_PASSWORD=super123 SEED_ADMIN_PASSWORD=admin123 SEED_CLIENT_PASSWORD=client123 PORT=5100 pnpm dev
```
Expected: server log shows `[seed] created super/admin/client ... (password from env)`. (Migrations auto-apply via `createTestDb` analog in dev: drizzle runs through the app's `useDb`; if dev doesn't auto-migrate, run `pnpm db:migrate` first.) Stop the server after confirming.

- [ ] **Step 4: Commit** — `git add server/plugins/seed.ts .env.example && git commit -m "feat(auth): run seed on Nitro startup"`

---

# Phase D — Auth endpoints + middleware

### Task 7: Login / logout / me endpoints

**Files:** Create `server/api/auth/login.post.ts`, `server/api/auth/logout.post.ts`, `server/api/auth/me.get.ts` · Modify `tests/helpers/nuxt-stubs.ts` · Test `tests/api/auth-login.test.ts`

- [ ] **Step 1: Add cookie stubs to `tests/helpers/nuxt-stubs.ts`** (append near the other stubs)

```ts
;(globalThis as any).getCookie = notInTests('getCookie')
;(globalThis as any).setCookie = notInTests('setCookie')
;(globalThis as any).deleteCookie = notInTests('deleteCookie')
```

- [ ] **Step 2: Write the failing test** (tests the pure `authenticateUser`, not the cookie wrapper)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { hashPassword } from '~/server/services/password'
import { authenticateUser } from '~/server/api/auth/login.post'
import { getSessionUser } from '~/server/services/sessions'

describe('authenticateUser', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('returns a user + valid session token for correct credentials', async () => {
    await seedUser(db, { username: 'admin', role: 'admin', passwordHash: await hashPassword('pw') })
    const result = await authenticateUser(db, { username: 'admin', password: 'pw' })
    expect(result).not.toBeNull()
    expect(result!.user.username).toBe('admin')
    expect(await getSessionUser(db, result!.token)).toMatchObject({ username: 'admin' })
  })

  it('returns null for a wrong password', async () => {
    await seedUser(db, { username: 'admin', role: 'admin', passwordHash: await hashPassword('pw') })
    expect(await authenticateUser(db, { username: 'admin', password: 'nope' })).toBeNull()
  })

  it('returns null for an unknown user', async () => {
    expect(await authenticateUser(db, { username: 'ghost', password: 'x' })).toBeNull()
  })
})
```

- [ ] **Step 3: Run → fail.**
- [ ] **Step 4: Implement `server/api/auth/login.post.ts`**

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { verifyPassword } from '~/server/services/password'
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Role,
  type SessionUser
} from '~/server/services/sessions'

const BodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256)
})

export async function authenticateUser(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<{ user: SessionUser; token: string } | null> {
  const body = BodySchema.parse(rawBody)
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, body.username))
  if (!u) return null
  if (!(await verifyPassword(body.password, u.passwordHash))) return null
  const token = await createSession(db, u.id)
  return {
    user: { id: u.id, username: u.username, role: u.role as Role, organizationId: u.organizationId },
    token
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const result = await authenticateUser(useDb(), body)
  if (!result) throw createError({ statusCode: 401, message: 'Invalid username or password' })
  setCookie(event, SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  })
  return { user: result.user }
})
```

- [ ] **Step 5: Implement `server/api/auth/logout.post.ts`**

```ts
import { useDb } from '~/server/db/client'
import { deleteSession, SESSION_COOKIE } from '~/server/services/sessions'

export default defineEventHandler(async (event) => {
  await deleteSession(useDb(), getCookie(event, SESSION_COOKIE))
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 6: Implement `server/api/auth/me.get.ts`**

```ts
export default defineEventHandler((event) => {
  const user = event.context.user
  if (!user) throw createError({ statusCode: 401, message: 'Not authenticated' })
  return { user }
})
```

- [ ] **Step 7: Run → pass.** `pnpm vitest run tests/api/auth-login.test.ts`
- [ ] **Step 8: Commit** — `git add server/api/auth tests/helpers/nuxt-stubs.ts tests/api/auth-login.test.ts && git commit -m "feat(auth): login/logout/me endpoints"`

### Task 8: Auth middleware

**Files:** Create `server/middleware/auth.ts`

- [ ] **Step 1: Implement `server/middleware/auth.ts`** (logic already unit-tested via `decideAccess`/`getSessionUser`; this is thin glue)

```ts
import { useDb } from '~/server/db/client'
import { getSessionUser, SESSION_COOKIE } from '~/server/services/sessions'
import { decideAccess } from '~/server/services/auth-guard'

export default defineEventHandler(async (event) => {
  const user = await getSessionUser(useDb(), getCookie(event, SESSION_COOKIE))
  event.context.user = user

  const decision = decideAccess(event.path, user)
  if (!decision.ok) {
    throw createError({
      statusCode: decision.status,
      message: decision.status === 401 ? 'Authentication required' : 'Forbidden'
    })
  }
})
```

- [ ] **Step 2: Manual verify the boundary** (with the dev server running + seed done from Task 6):

```bash
# device endpoints stay open (no cookie):
curl -s -o /dev/null -w "register:%{http_code}\n" -X POST http://localhost:5100/api/devices/register -H 'content-type: application/json' -d '{"deviceId":"probe","playerVersion":"x"}'
curl -s -o /dev/null -w "manifest:%{http_code}\n" http://localhost:5100/api/devices/probe/manifest
curl -s -o /dev/null -w "healthz:%{http_code}\n" http://localhost:5100/api/healthz
# dashboard endpoint blocked without a session:
curl -s -o /dev/null -w "media(noauth):%{http_code}\n" http://localhost:5100/api/media
# login, then dashboard works with the cookie jar:
curl -s -c /tmp/jar -X POST http://localhost:5100/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w "login:%{http_code}\n"
curl -s -b /tmp/jar -o /dev/null -w "media(auth):%{http_code}\n" http://localhost:5100/api/media
```
Expected: `register:200 manifest:204 healthz:200 media(noauth):401 login:200 media(auth):200`.

- [ ] **Step 3: Run the full suite** — `pnpm test` → still green (handler tests bypass middleware; nothing broke).
- [ ] **Step 4: Commit** — `git add server/middleware/auth.ts && git commit -m "feat(auth): Nitro middleware enforcing route tiers"`

---

# Phase E — Reach stats + portal API

### Task 9: Reach computation service

**Files:** Create `server/services/reach.ts` · Test `tests/services/reach.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import {
  seedAddress, seedGroup, seedDevice, seedMedia, seedPlaylist, assign, seedOrganization
} from '../helpers/fixtures'
import { computeOrgReach } from '~/server/services/reach'
import * as schema from '~/server/db/schema'
import { eq } from 'drizzle-orm'

describe('computeOrgReach', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('counts scheduled / online / showing-now screens for the org-owned media only', async () => {
    const org = await seedOrganization(db, 'Acme')
    const other = await seedOrganization(db, 'Other')
    const addr = await seedAddress(db)
    const grp = await seedGroup(db, addr.id)
    const now = new Date('2026-06-07T12:00:00Z')

    // device online (seen 1 min ago)
    await seedDevice(db, { id: 'd1', groupId: grp.id })
    await db.update(schema.devices).set({ lastSeenAt: new Date(now.getTime() - 60_000) }).where(eq(schema.devices.id, 'd1'))

    const mine = await seedMedia(db, { sha256: 'mine', kind: 'image', organizationId: org.id })
    const theirs = await seedMedia(db, { sha256: 'theirs', kind: 'image', organizationId: other.id })
    const pl = await seedPlaylist(db, { items: [{ mediaId: mine.id }, { mediaId: theirs.id }] })
    await assign(db, { playlistId: pl.id, deviceId: 'd1' })

    // d1 is currently showing `mine`
    const [item] = await db.select().from(schema.playlistItems).where(eq(schema.playlistItems.mediaId, mine.id))
    await db.update(schema.devices).set({ currentItemId: item.id }).where(eq(schema.devices.id, 'd1'))

    const reach = await computeOrgReach(db, org.id, now)
    expect(reach!.organization.name).toBe('Acme')
    expect(reach!.media).toHaveLength(1) // only Acme's media
    expect(reach!.media[0]).toMatchObject({
      mediaId: mine.id, screensScheduled: 1, screensOnline: 1, screensShowingNow: 1
    })
    expect(reach!.totals).toMatchObject({ mediaCount: 1, screensReached: 1, screensOnline: 1, showingNow: 1 })
  })

  it('returns zero counts when the org media is on no playlist', async () => {
    const org = await seedOrganization(db)
    await seedMedia(db, { sha256: 'lonely', kind: 'image', organizationId: org.id })
    const reach = await computeOrgReach(db, org.id, new Date())
    expect(reach!.media[0].screensScheduled).toBe(0)
    expect(reach!.totals.screensReached).toBe(0)
  })

  it('returns null for an unknown organization', async () => {
    expect(await computeOrgReach(db, 999, new Date())).toBeNull()
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/services/reach.ts`**

```ts
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { resolvePlaylistForDevice } from './resolver'

const ONLINE_WINDOW_MS = 5 * 60 * 1000

export type MediaReach = {
  mediaId: number
  filename: string
  kind: 'video' | 'image'
  screensScheduled: number
  screensOnline: number
  screensShowingNow: number
  recentErrors: number
}
export type OrgReach = {
  organization: { id: number; name: string }
  totals: { mediaCount: number; screensReached: number; screensOnline: number; showingNow: number }
  media: MediaReach[]
}

export async function computeOrgReach(
  db: BetterSQLite3Database<typeof schema>,
  organizationId: number,
  now = new Date()
): Promise<OrgReach | null> {
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
  if (!org) return null

  const orgMedia = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.organizationId, organizationId))
  const orgMediaIds = new Set(orgMedia.map((m) => m.id))

  const acc = new Map<number, { scheduled: Set<string>; online: Set<string>; now: Set<string> }>()
  for (const m of orgMedia) acc.set(m.id, { scheduled: new Set(), online: new Set(), now: new Set() })

  const devices = await db.select().from(schema.devices)
  const playlistMedia = new Map<number, number[]>()
  const itemToMedia = new Map<number, number>()

  for (const dev of devices) {
    const resolved = await resolvePlaylistForDevice(db, dev.id)
    if (!resolved) continue
    if (!playlistMedia.has(resolved.playlistId)) {
      const items = await db
        .select({ id: schema.playlistItems.id, mediaId: schema.playlistItems.mediaId })
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.playlistId, resolved.playlistId))
      playlistMedia.set(resolved.playlistId, items.map((i) => i.mediaId))
      for (const i of items) itemToMedia.set(i.id, i.mediaId)
    }
    const online = !!dev.lastSeenAt && now.getTime() - dev.lastSeenAt.getTime() <= ONLINE_WINDOW_MS
    const nowMediaId = dev.currentItemId != null ? itemToMedia.get(dev.currentItemId) : undefined
    for (const mid of playlistMedia.get(resolved.playlistId)!) {
      if (!orgMediaIds.has(mid)) continue
      const a = acc.get(mid)!
      a.scheduled.add(dev.id)
      if (online) a.online.add(dev.id)
      if (nowMediaId === mid) a.now.add(dev.id)
    }
  }

  const shaToMedia = new Map(orgMedia.map((m) => [m.sha256, m.id]))
  const errorCounts = new Map<number, number>()
  if (orgMedia.length > 0) {
    const errs = await db
      .select({ sha256: schema.deviceErrors.sha256 })
      .from(schema.deviceErrors)
      .where(inArray(schema.deviceErrors.sha256, orgMedia.map((m) => m.sha256)))
    for (const e of errs) {
      const mid = e.sha256 ? shaToMedia.get(e.sha256) : undefined
      if (mid != null) errorCounts.set(mid, (errorCounts.get(mid) ?? 0) + 1)
    }
  }

  const media: MediaReach[] = orgMedia.map((m) => {
    const a = acc.get(m.id)!
    return {
      mediaId: m.id,
      filename: m.filename,
      kind: m.kind as 'video' | 'image',
      screensScheduled: a.scheduled.size,
      screensOnline: a.online.size,
      screensShowingNow: a.now.size,
      recentErrors: errorCounts.get(m.id) ?? 0
    }
  })

  const reached = new Set<string>()
  const onlineAll = new Set<string>()
  const nowAll = new Set<string>()
  for (const a of acc.values()) {
    a.scheduled.forEach((d) => reached.add(d))
    a.online.forEach((d) => onlineAll.add(d))
    a.now.forEach((d) => nowAll.add(d))
  }

  return {
    organization: { id: org.id, name: org.name },
    totals: { mediaCount: orgMedia.length, screensReached: reached.size, screensOnline: onlineAll.size, showingNow: nowAll.size },
    media
  }
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add server/services/reach.ts tests/services/reach.test.ts && git commit -m "feat(portal): org media reach computation"`

### Task 10: Portal stats endpoint

**Files:** Create `server/api/portal/stats.get.ts` · Test `tests/api/portal-stats.test.ts`

- [ ] **Step 1: Write the failing test** (handler reads `event.context.user`; test the access logic via a tiny fake event)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedMedia } from '../helpers/fixtures'
import { handlePortalStats } from '~/server/api/portal/stats.get'

describe('handlePortalStats', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('returns reach for the user’s own org', async () => {
    const org = await seedOrganization(db, 'Mine')
    await seedMedia(db, { sha256: 'a', kind: 'image', organizationId: org.id })
    const res = await handlePortalStats(db, { id: 1, username: 'c', role: 'client', organizationId: org.id })
    expect(res.organization.name).toBe('Mine')
    expect(res.totals.mediaCount).toBe(1)
  })

  it('throws 400 when the client has no organization', async () => {
    await expect(
      handlePortalStats(db, { id: 1, username: 'c', role: 'client', organizationId: null })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/api/portal/stats.get.ts`**

```ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { computeOrgReach, type OrgReach } from '~/server/services/reach'
import type { SessionUser } from '~/server/services/sessions'

export async function handlePortalStats(
  db: BetterSQLite3Database<typeof schema>,
  user: SessionUser
): Promise<OrgReach> {
  if (user.organizationId == null) {
    throw createError({ statusCode: 400, message: 'Client is not linked to an organization' })
  }
  const reach = await computeOrgReach(db, user.organizationId)
  if (!reach) throw createError({ statusCode: 404, message: 'Organization not found' })
  return reach
}

export default defineEventHandler(async (event) => {
  const user = requireRole(event.context.user, ['client'])
  return handlePortalStats(useDb(), user)
})
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add server/api/portal tests/api/portal-stats.test.ts && git commit -m "feat(portal): GET /api/portal/stats (client-scoped)"`

---

# Phase F — Organizations admin API + media→org

### Task 11: Organizations list/create endpoints

**Files:** Create `server/api/organizations/index.get.ts`, `server/api/organizations/index.post.ts` · Test `tests/api/organizations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleListOrganizations } from '~/server/api/organizations/index.get'
import { handleCreateOrganization } from '~/server/api/organizations/index.post'

describe('organizations API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates and lists organizations alphabetically', async () => {
    await handleCreateOrganization(db, { name: 'Zeta' })
    await handleCreateOrganization(db, { name: 'Alpha' })
    const list = await handleListOrganizations(db)
    expect(list.map((o) => o.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('rejects an empty name', async () => {
    await expect(handleCreateOrganization(db, { name: '' })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/api/organizations/index.get.ts`**

```ts
import { asc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

export async function handleListOrganizations(db: BetterSQLite3Database<typeof schema>) {
  return db.select().from(schema.organizations).orderBy(asc(schema.organizations.name))
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  return handleListOrganizations(useDb())
})
```

- [ ] **Step 4: Implement `server/api/organizations/index.post.ts`**

```ts
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

const BodySchema = z.object({ name: z.string().min(1).max(120) })

export async function handleCreateOrganization(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [row] = await db.insert(schema.organizations).values({ name: body.name }).returning()
  return row
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  return handleCreateOrganization(useDb(), await readBody(event))
})
```

- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** — `git add server/api/organizations tests/api/organizations.test.ts && git commit -m "feat(orgs): list/create organizations API"`

### Task 12: Assign media → organization

**Files:** Create `server/api/media/[id]/organization.put.ts` · Test `tests/api/media-organization.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedOrganization } from '../helpers/fixtures'
import { handleAssignMediaOrg } from '~/server/api/media/[id]/organization.put'

describe('handleAssignMediaOrg', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('assigns and unassigns media ownership', async () => {
    const org = await seedOrganization(db)
    const m = await seedMedia(db, { sha256: 'a', kind: 'image' })
    const assigned = await handleAssignMediaOrg(db, m.id, { organizationId: org.id })
    expect(assigned.organizationId).toBe(org.id)
    const cleared = await handleAssignMediaOrg(db, m.id, { organizationId: null })
    expect(cleared.organizationId).toBeNull()
  })

  it('404s unknown media', async () => {
    await expect(handleAssignMediaOrg(db, 999, { organizationId: null })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s an unknown organization', async () => {
    const m = await seedMedia(db, { sha256: 'a', kind: 'image' })
    await expect(handleAssignMediaOrg(db, m.id, { organizationId: 777 })).rejects.toMatchObject({ statusCode: 400 })
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `server/api/media/[id]/organization.put.ts`**

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'

const BodySchema = z.object({ organizationId: z.number().int().positive().nullable() })

export async function handleAssignMediaOrg(
  db: BetterSQLite3Database<typeof schema>,
  mediaId: number,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId))
  if (!m) throw createError({ statusCode: 404, message: 'Media not found' })
  if (body.organizationId != null) {
    const [o] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, body.organizationId))
    if (!o) throw createError({ statusCode: 400, message: 'Organization not found' })
  }
  const [row] = await db
    .update(schema.media)
    .set({ organizationId: body.organizationId })
    .where(eq(schema.media.id, mediaId))
    .returning()
  return row
}

export default defineEventHandler(async (event) => {
  requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, message: 'Bad media id' })
  return handleAssignMediaOrg(useDb(), id, await readBody(event))
})
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git add server/api/media tests/api/media-organization.test.ts && git commit -m "feat(orgs): PUT media organization owner"`

---

# Phase G — Frontend: types, API client, auth store, guard, login

### Task 13: Types + API client additions

**Files:** Modify `app/types/api.ts`, `app/composables/useApiClient.ts`

- [ ] **Step 1: Add types to `app/types/api.ts`** (append)

```ts
export type Role = 'super' | 'admin' | 'client'
export interface SessionUser {
  id: number
  username: string
  role: Role
  organizationId: number | null
}
export interface Organization {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}
export interface MediaReach {
  mediaId: number
  filename: string
  kind: 'video' | 'image'
  screensScheduled: number
  screensOnline: number
  screensShowingNow: number
  recentErrors: number
}
export interface OrgReach {
  organization: { id: number; name: string }
  totals: { mediaCount: number; screensReached: number; screensOnline: number; showingNow: number }
  media: MediaReach[]
}
```

Also add `organizationId: number | null` to the existing `Media` and `MediaListRow` interfaces in this file.

- [ ] **Step 2: Add methods to the `ApiClient` interface** in `app/composables/useApiClient.ts` (add to the imports from `~/app/types/api`: `Organization`, `OrgReach`, `SessionUser`; then add to the interface)

```ts
  // auth
  login(body: { username: string; password: string }): Promise<{ user: SessionUser }>
  logout(): Promise<void>
  me(): Promise<{ user: SessionUser }>

  // organizations
  listOrganizations(): Promise<Organization[]>
  createOrganization(body: { name: string }): Promise<Organization>
  assignMediaOrganization(mediaId: number, body: { organizationId: number | null }): Promise<Media>

  // portal
  getPortalStats(): Promise<OrgReach>
```

- [ ] **Step 3: Add implementations** in `createApiClient` (inside the returned object)

```ts
    // auth
    login: (body) => fetch<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body }),
    logout: () => fetch<void>('/api/auth/logout', { method: 'POST' }),
    me: () => fetch<{ user: SessionUser }>('/api/auth/me', { method: 'GET' }),
    // organizations
    listOrganizations: () => fetch<Organization[]>('/api/organizations', { method: 'GET' }),
    createOrganization: (body) => fetch<Organization>('/api/organizations', { method: 'POST', body }),
    assignMediaOrganization: (mediaId, body) =>
      fetch<Media>(`/api/media/${mediaId}/organization`, { method: 'PUT', body }),
    // portal
    getPortalStats: () => fetch<OrgReach>('/api/portal/stats', { method: 'GET' }),
```

- [ ] **Step 4: Typecheck** — `pnpm exec nuxt typecheck` (or `pnpm build`) compiles. Commit:

```bash
git add app/types/api.ts app/composables/useApiClient.ts
git commit -m "feat(web): api client methods for auth/orgs/portal"
```

### Task 14: Auth store

**Files:** Create `app/stores/auth.ts` · Test `tests/stores/auth.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `tests/stores/devices.test.ts` style: patch `_api`)

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '~/app/stores/auth'
import type { SessionUser } from '~/app/types/api'

const admin: SessionUser = { id: 1, username: 'admin', role: 'admin', organizationId: null }

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('fetchMe sets the user on success', async () => {
    const s = useAuthStore()
    s.$patch({ _api: { me: async () => ({ user: admin }), login: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toEqual(admin)
    expect(s.isAuthenticated).toBe(true)
    expect(s.ready).toBe(true)
  })

  it('fetchMe clears the user on 401', async () => {
    const s = useAuthStore()
    s.$patch({ _api: { me: async () => { throw new Error('401') }, login: async () => ({ user: admin }), logout: async () => {} } })
    await s.fetchMe()
    expect(s.user).toBeNull()
    expect(s.ready).toBe(true)
  })

  it('login stores the returned user', async () => {
    const s = useAuthStore()
    s.$patch({ _api: { me: async () => ({ user: admin }), login: async () => ({ user: admin }), logout: async () => {} } })
    const u = await s.login('admin', 'pw')
    expect(u).toEqual(admin)
    expect(s.role).toBe('admin')
  })
})
```

(Ensure `tests/setup.ts` / vitest config already imports `nuxt-stubs`; the existing `tests/stores/devices.test.ts` confirms the Pinia+stub setup works.)

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `app/stores/auth.ts`**

```ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Role, SessionUser } from '~/app/types/api'

interface State {
  user: SessionUser | null
  ready: boolean
  _api: Pick<ApiClient, 'login' | 'logout' | 'me'>
}

export const useAuthStore = defineStore('auth', {
  state: (): State => ({ user: null, ready: false, _api: useApiClient() }),
  getters: {
    isAuthenticated: (s): boolean => s.user !== null,
    role: (s): Role | null => s.user?.role ?? null
  },
  actions: {
    async fetchMe() {
      try {
        const { user } = await this._api.me()
        this.user = user
      } catch {
        this.user = null
      } finally {
        this.ready = true
      }
    },
    async login(username: string, password: string): Promise<SessionUser> {
      const { user } = await this._api.login({ username, password })
      this.user = user
      this.ready = true
      return user
    },
    async logout() {
      await this._api.logout()
      this.user = null
    }
  }
})
```

- [ ] **Step 4: Run → pass.** Commit: `git add app/stores/auth.ts tests/stores/auth.test.ts && git commit -m "feat(web): auth store"`

### Task 15: Client route guard + login page

**Files:** Create `app/middleware/auth.global.ts`, `app/pages/login.vue`

- [ ] **Step 1: Create `app/middleware/auth.global.ts`**

```ts
export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.fetchMe()

  const onLogin = to.path === '/login'
  if (!auth.isAuthenticated) {
    return onLogin ? undefined : navigateTo('/login')
  }
  if (onLogin) {
    return navigateTo(auth.role === 'client' ? '/portal' : '/')
  }
  if (auth.role === 'client' && !to.path.startsWith('/portal')) {
    return navigateTo('/portal')
  }
  if (auth.role !== 'client' && to.path.startsWith('/portal')) {
    return navigateTo('/')
  }
})
```

- [ ] **Step 2: Create `app/pages/login.vue`** (new light theme; uses Nuxt UI form controls)

```vue
<script setup lang="ts">
definePageMeta({ layout: false })
const auth = useAuthStore()
const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

async function submit() {
  error.value = null
  loading.value = true
  try {
    const user = await auth.login(username.value, password.value)
    await navigateTo(user.role === 'client' ? '/portal' : '/')
  } catch {
    error.value = 'Invalid username or password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-bg flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-sm rounded-3xl border border-black/5 bg-white/80 p-8 shadow-xl backdrop-blur">
      <div class="mb-6 flex items-center gap-2">
        <UIcon name="i-lucide-radio-tower" class="size-6 text-black" />
        <span class="text-xl font-semibold tracking-tight">Lanka</span>
      </div>
      <h1 class="mb-1 text-2xl font-bold tracking-tight">Sign in</h1>
      <p class="mb-6 text-sm text-(--ui-text-muted)">Manage your signage network.</p>

      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="Username">
          <UInput v-model="username" autocomplete="username" size="lg" class="w-full" />
        </UFormField>
        <UFormField label="Password">
          <UInput v-model="password" type="password" autocomplete="current-password" size="lg" class="w-full" />
        </UFormField>
        <p v-if="error" class="text-sm text-rose-500">{{ error }}</p>
        <UButton
          type="submit"
          block
          size="lg"
          color="neutral"
          :loading="loading"
          class="rounded-xl"
        >
          Sign in
        </UButton>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-bg {
  background:
    radial-gradient(1200px 600px at 20% -10%, rgba(124, 138, 255, 0.18), transparent 60%),
    radial-gradient(900px 500px at 90% 10%, rgba(255, 120, 120, 0.12), transparent 55%),
    linear-gradient(180deg, #f3f4fb 0%, #ffffff 100%);
}
</style>
```

- [ ] **Step 3: Manual verify** — restart `PORT=5100 pnpm dev`, open `http://localhost:5100/` → redirected to `/login`. Log in as `admin` → lands on Overview. Log in as `client` → lands on `/portal` (will 404 until Task 16; that's expected ordering).
- [ ] **Step 4: Commit** — `git add app/middleware/auth.global.ts app/pages/login.vue && git commit -m "feat(web): login page + client-side route guard"`

---

# Phase H — Frontend: portal + organizations pages

### Task 16: Portal layout + portal page

**Files:** Create `app/layouts/portal.vue`, `app/pages/portal/index.vue`

- [ ] **Step 1: Create `app/layouts/portal.vue`** (minimal client chrome — no management sidebar)

```vue
<script setup lang="ts">
const auth = useAuthStore()
async function signOut() {
  await auth.logout()
  await navigateTo('/login')
}
</script>

<template>
  <div class="app-bg min-h-screen">
    <header class="flex h-16 items-center justify-between px-6 sm:px-10">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-radio-tower" class="size-6 text-black" />
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
        <span class="ml-2 rounded-full bg-black px-2.5 py-0.5 text-xs font-medium text-white">Client</span>
      </div>
      <div class="flex items-center gap-3 text-sm text-(--ui-text-muted)">
        <span>{{ auth.user?.username }}</span>
        <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-log-out" @click="signOut" />
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-6 pb-16 sm:px-10">
      <slot />
    </main>
  </div>
</template>
```

- [ ] **Step 2: Create `app/pages/portal/index.vue`**

```vue
<script setup lang="ts">
import type { OrgReach } from '~/app/types/api'
definePageMeta({ layout: 'portal' })

const api = useApiClient()
const stats = ref<OrgReach | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    stats.value = await api.getPortalStats()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load stats'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="pt-4">
    <h1 class="mb-1 text-3xl font-bold tracking-tight">
      {{ stats?.organization.name ?? 'Your stats' }}
    </h1>
    <p class="mb-8 text-sm text-(--ui-text-muted)">Reach of your content across the network.</p>

    <p v-if="loading" class="text-(--ui-text-muted)">Loading…</p>
    <p v-else-if="error" class="text-rose-500">{{ error }}</p>

    <template v-else-if="stats">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Media items" :value="stats.totals.mediaCount" icon="i-lucide-image" />
        <StatCard label="Screens reached" :value="stats.totals.screensReached" icon="i-lucide-tv" tone="blue" />
        <StatCard label="Online now" :value="stats.totals.screensOnline" icon="i-lucide-wifi" tone="emerald" />
        <StatCard label="Showing now" :value="stats.totals.showingNow" icon="i-lucide-play" tone="amber" />
      </div>

      <div class="mt-8 overflow-hidden rounded-3xl border border-black/5 bg-white/80 shadow-sm">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase tracking-wide text-(--ui-text-muted)">
            <tr class="border-b border-black/5">
              <th class="px-5 py-3 font-medium">Media</th>
              <th class="px-5 py-3 font-medium tabular-nums">Scheduled</th>
              <th class="px-5 py-3 font-medium tabular-nums">Online</th>
              <th class="px-5 py-3 font-medium tabular-nums">Showing now</th>
              <th class="px-5 py-3 font-medium tabular-nums">Errors</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in stats.media" :key="m.mediaId" class="border-b border-black/5 last:border-0">
              <td class="px-5 py-3">
                <span class="font-medium">{{ m.filename }}</span>
                <span class="ml-2 rounded-full bg-black/5 px-2 py-0.5 text-xs">{{ m.kind }}</span>
              </td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensScheduled }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensOnline }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensShowingNow }}</td>
              <td class="px-5 py-3 tabular-nums" :class="m.recentErrors ? 'text-rose-500' : ''">{{ m.recentErrors }}</td>
            </tr>
            <tr v-if="stats.media.length === 0">
              <td colspan="5" class="px-5 py-8 text-center text-(--ui-text-muted)">No media assigned to your organization yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
```

(Note: `StatCard` gains a `'blue'` tone in Task 20; ordering is fine because pages render after that task in the final verify.)

- [ ] **Step 3: Manual verify** — log in as `client` → portal renders stat cards + media table (Demo Organization, with the media adopted by the seed). Sign out works.
- [ ] **Step 4: Commit** — `git add app/layouts/portal.vue app/pages/portal/index.vue && git commit -m "feat(portal): client stats page + minimal layout"`

### Task 17: Organizations admin page + media owner control

**Files:** Create `app/stores/organizations.ts`, `app/pages/organizations/index.vue`

- [ ] **Step 1: Create `app/stores/organizations.ts`**

```ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { Organization } from '~/app/types/api'

interface State {
  list: Organization[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listOrganizations' | 'createOrganization'>
}

export const useOrganizationsStore = defineStore('organizations', {
  state: (): State => ({ list: [], loading: false, error: null, _api: useApiClient() }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listOrganizations()
      } catch (e: any) {
        this.error = e?.message ?? String(e)
      } finally {
        this.loading = false
      }
    },
    async create(name: string) {
      const org = await this._api.createOrganization({ name })
      this.list = [...this.list, org].sort((a, b) => a.name.localeCompare(b.name))
      return org
    }
  }
})
```

- [ ] **Step 2: Create `app/pages/organizations/index.vue`**

```vue
<script setup lang="ts">
definePageMeta({ layout: 'default' })
const store = useOrganizationsStore()
const name = ref('')
const creating = ref(false)

onMounted(() => store.refresh())

async function add() {
  if (!name.value.trim()) return
  creating.value = true
  try {
    await store.create(name.value.trim())
    name.value = ''
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="mb-1 text-3xl font-bold tracking-tight">Organizations</h1>
    <p class="mb-8 text-sm text-(--ui-text-muted)">Companies that own media. Client accounts see stats for their org.</p>

    <div class="mb-6 flex max-w-md gap-2">
      <UInput v-model="name" placeholder="New organization name" size="lg" class="flex-1" @keyup.enter="add" />
      <UButton color="neutral" size="lg" class="rounded-xl" :loading="creating" @click="add">Add</UButton>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="org in store.list"
        :key="org.id"
        class="rounded-2xl border border-black/5 bg-white/80 p-5 shadow-sm"
      >
        <p class="font-medium">{{ org.name }}</p>
        <p class="mt-1 text-xs text-(--ui-text-muted)">#{{ org.id }}</p>
      </div>
      <p v-if="!store.loading && store.list.length === 0" class="text-(--ui-text-muted)">No organizations yet.</p>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Add the nav item + media owner hint** — covered when the sidebar is rebuilt in Task 19 (the `Organizations` link is added there). The media→org **assignment control** (a per-media `USelectMenu` of organizations calling `api.assignMediaOrganization`) lands on the Media page in **Round 2**; for Round 1 the seed assigns media to the demo org, so the portal has data and the Organizations page proves the entity works.
- [ ] **Step 4: Manual verify** — as `admin`, visit `/organizations` → create one → it appears. Commit:

```bash
git add app/stores/organizations.ts app/pages/organizations/index.vue
git commit -m "feat(orgs): organizations admin page"
```

---

# Phase I — Light theme

### Task 18: Theme foundation (fonts, palette, gradient, color-mode default)

**Files:** Modify `nuxt.config.ts`, `app/app.config.ts`, `app/assets/css/main.css`

- [ ] **Step 1: Default to light + register fonts in `nuxt.config.ts`**

Change `colorMode` block:
```ts
  colorMode: {
    preference: 'light',
    fallback: 'light',
    classSuffix: ''
  },
```
Add a `fonts` config (the `@nuxt/fonts` module is already registered):
```ts
  fonts: {
    families: [
      { name: 'Bricolage Grotesque', provider: 'google' },
      { name: 'Hanken Grotesque', provider: 'google' }
    ]
  },
```

- [ ] **Step 2: Update `app/app.config.ts`**

```ts
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'blue',
      neutral: 'slate'
    }
  }
})
```

- [ ] **Step 3: Rewrite `app/assets/css/main.css`**

```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-sans: "Hanken Grotesque", system-ui, sans-serif;
  --font-display: "Bricolage Grotesque", "Hanken Grotesque", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

:root {
  min-width: 1280px;
}

/* Soft lavender→white atmosphere used by the app shell + auth/portal screens. */
.app-bg {
  background:
    radial-gradient(1200px 600px at 15% -10%, rgba(124, 138, 255, 0.16), transparent 60%),
    radial-gradient(1000px 520px at 95% 0%, rgba(255, 120, 120, 0.10), transparent 55%),
    linear-gradient(180deg, #f4f5fc 0%, #ffffff 55%);
}

body {
  @apply text-(--ui-text);
  min-width: 1280px;
}

h1, h2, h3 {
  font-family: var(--font-display);
}

/* Reusable soft card */
.soft-card {
  @apply rounded-3xl border border-black/5 bg-white/80 shadow-sm backdrop-blur;
}
```

- [ ] **Step 4: Manual verify** — restart dev; the login page now uses Bricolage/Hanken fonts and the light gradient. Fonts download on first load (network tab shows Google fonts). Commit:

```bash
git add nuxt.config.ts app/app.config.ts app/assets/css/main.css
git commit -m "feat(theme): light soft-card foundation (fonts, palette, gradient)"
```

### Task 19: Restyle the sidebar shell + logout + role-aware nav

**Files:** Modify `app/layouts/default.vue`

- [ ] **Step 1: Replace `app/layouts/default.vue`** with the light-themed shell (adds `Organizations` nav, user identity, logout; black active pill)

```vue
<script setup lang="ts">
const route = useRoute()
const auth = useAuthStore()

const navItems = [
  { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: 'Addresses', icon: 'i-lucide-building-2', to: '/addresses' },
  { label: 'Groups', icon: 'i-lucide-folder', to: '/groups' },
  { label: 'Devices', icon: 'i-lucide-tv', to: '/devices' },
  { label: 'Media', icon: 'i-lucide-image', to: '/media' },
  { label: 'Playlists', icon: 'i-lucide-list-music', to: '/playlists' },
  { label: 'Organizations', icon: 'i-lucide-briefcase', to: '/organizations' }
]

const stream = import.meta.client ? useDashboardStream() : null
const streamState = computed(() => (stream ? stream.state.value : ('connecting' as const)))

const colorMode = useColorMode()
function toggleDark() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
async function signOut() {
  await auth.logout()
  await navigateTo('/login')
}
function isActive(to: string) {
  return route.path === to || (to !== '/' && route.path.startsWith(to))
}
</script>

<template>
  <div class="app-bg flex h-screen">
    <aside class="flex w-64 flex-col px-3 py-4">
      <div class="flex h-12 items-center gap-2 px-3">
        <UIcon name="i-lucide-radio-tower" class="size-6 text-black" />
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
      </div>

      <nav class="mt-4 flex-1 space-y-1">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors"
          :class="isActive(item.to)
            ? 'bg-black text-white shadow-sm'
            : 'text-(--ui-text-muted) hover:bg-black/5 hover:text-(--ui-text)'"
        >
          <UIcon :name="item.icon" class="size-4" />
          {{ item.label }}
        </NuxtLink>
      </nav>

      <div class="space-y-3 px-1">
        <div class="flex items-center gap-2 px-2 text-xs text-(--ui-text-muted)">
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
        <div class="flex items-center justify-between rounded-2xl bg-white/70 px-3 py-2 shadow-sm">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ auth.user?.username }}</p>
            <p class="text-xs capitalize text-(--ui-text-muted)">{{ auth.role }}</p>
          </div>
          <div class="flex items-center">
            <UButton
              variant="ghost" color="neutral" size="sm"
              :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
              :aria-label="`Switch to ${colorMode.value === 'dark' ? 'light' : 'dark'} mode`"
              @click="toggleDark"
            />
            <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-log-out" aria-label="Sign out" @click="signOut" />
          </div>
        </div>
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto">
      <div class="px-8 py-8">
        <slot />
      </div>
    </main>
  </div>
</template>
```

- [ ] **Step 2: Manual verify** — Overview shows the light shell, black active pill on the current nav item, username/role + logout in the sidebar footer. Commit:

```bash
git add app/layouts/default.vue
git commit -m "feat(theme): light sidebar shell with identity + logout"
```

### Task 20: Donut component, StatCard restyle, Overview polish

**Files:** Create `app/components/Donut.vue` · Modify `app/components/StatCard.vue`, `app/pages/index.vue`

- [ ] **Step 1: Create `app/components/Donut.vue`** (inline SVG, no dependency)

```vue
<script setup lang="ts">
const props = withDefaults(defineProps<{
  value: number
  total: number
  size?: number
  label?: string
  color?: string
}>(), { size: 132, color: '#5b8def' })

const radius = computed(() => props.size / 2 - 10)
const circumference = computed(() => 2 * Math.PI * radius.value)
const pct = computed(() => (props.total > 0 ? Math.min(1, props.value / props.total) : 0))
const dash = computed(() => `${circumference.value * pct.value} ${circumference.value}`)
</script>

<template>
  <div class="flex flex-col items-center">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="12" />
      <circle
        :cx="size / 2" :cy="size / 2" :r="radius" fill="none"
        :stroke="color" stroke-width="12" stroke-linecap="round"
        :stroke-dasharray="dash"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        style="transition: stroke-dasharray 600ms ease"
      />
      <text :x="size / 2" :y="size / 2 - 2" text-anchor="middle" class="fill-black font-display" font-size="26" font-weight="700">{{ value }}</text>
      <text :x="size / 2" :y="size / 2 + 18" text-anchor="middle" fill="rgba(0,0,0,0.45)" font-size="11">/ {{ total }}</text>
    </svg>
    <span v-if="label" class="mt-2 text-xs text-(--ui-text-muted)">{{ label }}</span>
  </div>
</template>
```

- [ ] **Step 2: Restyle `app/components/StatCard.vue`** (soft card; add `'blue'` tone used by the portal)

```vue
<!-- app/components/StatCard.vue -->
<script setup lang="ts">
defineProps<{
  label: string
  value: number | string
  icon?: string
  hint?: string
  tone?: 'neutral' | 'emerald' | 'amber' | 'rose' | 'blue'
}>()
</script>

<template>
  <div class="soft-card p-5">
    <div class="flex items-center gap-3">
      <div
        v-if="icon"
        class="rounded-xl p-2.5"
        :class="{
          'bg-black/5 text-black/70': !tone || tone === 'neutral',
          'bg-emerald-500/10 text-emerald-600': tone === 'emerald',
          'bg-amber-500/10 text-amber-600': tone === 'amber',
          'bg-rose-500/10 text-rose-500': tone === 'rose',
          'bg-blue-500/10 text-blue-600': tone === 'blue'
        }"
      >
        <UIcon :name="icon" class="size-5" />
      </div>
      <div>
        <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">{{ label }}</p>
        <p class="font-display text-3xl font-bold tabular-nums">{{ value }}</p>
      </div>
    </div>
    <p v-if="hint" class="mt-3 text-xs text-(--ui-text-muted)">{{ hint }}</p>
  </div>
</template>
```

- [ ] **Step 3: Polish `app/pages/index.vue`** — add a heading, the online/offline donut, and a staggered reveal

```vue
<!-- app/pages/index.vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useMediaStore } from '~/app/stores/media'
import { usePlaylistsStore } from '~/app/stores/playlists'

definePageMeta({ layout: 'default' })

const devicesStore = useDevicesStore()
const mediaStore = useMediaStore()
const playlistsStore = usePlaylistsStore()

onMounted(async () => {
  await Promise.all([devicesStore.refresh(), mediaStore.refresh(), playlistsStore.refresh()])
})

const stats = computed(() => {
  const total = devicesStore.list.length
  const online = devicesStore.list.filter((d) => d.status === 'online').length
  const offlineLong = devicesStore.list.filter((d) => d.status === 'offline' && d.groupId !== null).length
  const unclaimed = devicesStore.list.filter((d) => d.groupId === null).length
  return { total, online, offlineLong, unclaimed }
})
</script>

<template>
  <div class="reveal">
    <h1 class="mb-1 text-3xl font-bold tracking-tight">Overview</h1>
    <p class="mb-8 text-sm text-(--ui-text-muted)">Your signage network at a glance.</p>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <StatCard label="Total devices" :value="stats.total" icon="i-lucide-tv" />
      <StatCard label="Online now" :value="stats.online" icon="i-lucide-wifi" tone="emerald" />
      <StatCard label="Offline > 5 min" :value="stats.offlineLong" icon="i-lucide-wifi-off" tone="rose" />
      <StatCard label="Unclaimed" :value="stats.unclaimed" icon="i-lucide-inbox" tone="amber" />
    </div>

    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div class="soft-card flex items-center justify-center p-6">
        <Donut :value="stats.online" :total="stats.total" label="Screens online" color="#22c55e" />
      </div>
      <div class="lg:col-span-2">
        <UnclaimedDevicesTray />
      </div>
    </div>

    <div class="mt-6">
      <ErrorFeed />
    </div>
  </div>
</template>

<style scoped>
.reveal > * {
  animation: rise 480ms ease both;
}
.reveal > *:nth-child(2) { animation-delay: 60ms; }
.reveal > *:nth-child(3) { animation-delay: 120ms; }
.reveal > *:nth-child(4) { animation-delay: 180ms; }
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
```

- [ ] **Step 4: Manual verify** — Overview shows soft cards, a green online donut, staggered reveal. Commit:

```bash
git add app/components/Donut.vue app/components/StatCard.vue app/pages/index.vue
git commit -m "feat(theme): donut + soft StatCards + Overview polish"
```

---

# Phase J — Verification

### Task 21: Full verification pass

- [ ] **Step 1: Run the whole test suite** — `pnpm test`. Expected: all green, including `tests/services/auth-guard.test.ts` (device endpoints public), `tests/services/seed.test.ts`, `tests/services/reach.test.ts`, `tests/api/auth-login.test.ts`, `tests/api/portal-stats.test.ts`, `tests/api/organizations.test.ts`, `tests/api/media-organization.test.ts`, `tests/db/auth-schema.test.ts`, `tests/stores/auth.test.ts`, plus all pre-existing tests.
- [ ] **Step 2: Typecheck/build** — `pnpm build` succeeds (catches Vue template / TS issues).
- [ ] **Step 3: Browser smoke (devtools-frontend skill or chrome-devtools):**
  - `/` with no session → redirect to `/login`.
  - Login `admin` → Overview (soft cards, donut, black active pill, sidebar identity + logout).
  - Visit `/organizations` → create one.
  - Logout → `/login`. Login `client` → `/portal` shows the demo org's media reach table. Client cannot reach `/devices` (redirected to `/portal`).
  - Console clean (the prior "form field should have id/name" a11y nit is resolved by `UFormField` label wiring).
- [ ] **Step 4: Device-safety curl re-check** (from Task 8 Step 2) still returns `register:200 manifest:204 healthz:200 media(noauth):401`.
- [ ] **Step 5: Final commit if anything was touched during verification**, then hand back to `finishing-a-development-branch`.

---

## Self-review notes (author)

- **Spec coverage:** §4 model → Task 1; §5 auth (hashing/sessions/middleware/classification) → Tasks 2–4, 7–8; §6 login/roles/landing → Tasks 7,14,15,19; seeding → Tasks 5–6; §7 reach → Tasks 9–10; Organizations + media owner → Tasks 11–12,17; §8 theme → Tasks 18–20; §10 testing → every task + Task 21. Round-2 items (re-skin 5 pages, media→org UI on Media page, impressions) explicitly deferred.
- **Type consistency:** `SessionUser`/`Role` defined once in `server/services/sessions.ts` and mirrored in `app/types/api.ts`; `OrgReach`/`MediaReach` identical in `server/services/reach.ts` and `app/types/api.ts`; `SESSION_COOKIE` single source; `decideAccess`/`isPublicRoute`/`requireRole` names stable across Tasks 4/7/8/10/11/12.
- **Device safety:** `isPublicRoute` test (Task 4) + middleware curl check (Task 8) + final re-check (Task 21) guard against locking out TVs.
- **Ordering caveat:** `/portal` and the `'blue'` StatCard tone are referenced before their defining task in a couple of places; final state is consistent and Task 21 verifies end-to-end.
