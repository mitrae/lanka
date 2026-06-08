# User Management + Email Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `super` manage admin + client accounts and `admin` manage client accounts from the dashboard, with email as the login identity and self-service password reset by email.

**Architecture:** Server keeps the existing `handleXxx(db, …)` + thin `defineEventHandler` + Zod pattern. A pluggable `MailSender` (Resend in prod, log-only in dev/test) mirrors the existing `MediaStore` design. Password-reset tokens live in a new `password_reset_tokens` table modeled on `sessions`. The `users.username` column is renamed to `email` across the stack. Client side adds a `users` Pinia store, a `/users` management page, and public `/forgot-password` + `/reset-password` pages.

**Tech Stack:** Nuxt 4 (SPA) · Nitro · Drizzle ORM + better-sqlite3 · Zod v4 · Vitest (`pool: 'forks'`) · Resend HTTP API.

**Spec:** `docs/superpowers/specs/2026-06-08-lanka-user-management-email-reset-design.md`

**Conventions to follow (read before starting):**
- Server route files export a pure `handleXxx(db, …)` plus a `defineEventHandler` default export. Tests call `handleXxx` directly (Nitro auto-imports are stubbed in `tests/helpers/nuxt-stubs.ts`).
- Run a single test file: `pnpm test tests/api/users.test.ts`. Run all: `pnpm test`. Dev server: `PORT=5100 pnpm dev`.
- `~` resolves to repo root in both Nitro and Vitest.
- Commit after each task. Branch is already `feat/user-management`.

---

## Task 1: Rename `users.username` → `users.email` across the stack

This is a wide, behavior-preserving rename. It must land as one green commit. drizzle-kit's rename detection is **interactive** (unavailable here), so the migration + snapshot are authored by hand; the snapshot edit is done with a deterministic Python script.

**Files:**
- Modify: `server/db/schema.ts:170-194`
- Create: `server/db/migrations/0003_rename_users_username_to_email.sql`
- Create: `server/db/migrations/meta/0003_snapshot.json` (via script)
- Modify: `server/db/migrations/meta/_journal.json` (via script)
- Modify: `server/services/sessions.ts`, `server/api/auth/login.post.ts`, `app/types/api.ts`, `app/stores/auth.ts`, `app/composables/useApiClient.ts`, `app/pages/login.vue`, `app/layouts/default.vue`, `app/layouts/portal.vue`, `server/services/seed.ts`, `server/plugins/seed.ts`
- Modify (tests/fixtures): `tests/helpers/fixtures.ts`, `tests/api/auth-login.test.ts`, `tests/services/sessions.test.ts`, `tests/services/auth-guard.test.ts`, `tests/stores/auth.test.ts`, `tests/db/auth-schema.test.ts`, `tests/api/portal-stats.test.ts`

- [ ] **Step 1: Edit the schema** — `server/db/schema.ts`, in the `users` table replace the `username` column and its unique index:

```ts
    email: text('email').notNull(),
```
(was `username: text('username').notNull()`) and
```ts
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
```
(was `usernameIdx: uniqueIndex('users_username_idx').on(t.username)`). Leave the `roleOrg` check constraint untouched.

- [ ] **Step 2: Hand-write the rename migration** — create `server/db/migrations/0003_rename_users_username_to_email.sql`:

```sql
ALTER TABLE `users` RENAME COLUMN `username` TO `email`;--> statement-breakpoint
DROP INDEX `users_username_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);
```

- [ ] **Step 3: Generate the snapshot + journal entry deterministically** — run this Python (repo has `python3`); it derives snapshot `0003` from `0002` so future `db:generate` runs see `email` and never prompt:

```bash
python3 - <<'PY'
import json, uuid, copy
base = json.load(open('server/db/migrations/meta/0002_snapshot.json'))
snap = copy.deepcopy(base)
u = snap['tables']['users']
u['columns']['email'] = u['columns'].pop('username'); u['columns']['email']['name'] = 'email'
idx = u['indexes'].pop('users_username_idx'); idx['name'] = 'users_email_idx'; idx['columns'] = ['email']
u['indexes']['users_email_idx'] = idx
snap['prevId'] = base['id']; snap['id'] = str(uuid.uuid4())
json.dump(snap, open('server/db/migrations/meta/0003_snapshot.json','w'), indent=2)
jp = 'server/db/migrations/meta/_journal.json'; j = json.load(open(jp))
j['entries'].append({'idx':3,'version':'6','when':j['entries'][-1]['when']+1,'tag':'0003_rename_users_username_to_email','breakpoints':True})
json.dump(j, open(jp,'w'), indent=2)
print('wrote 0003 snapshot', snap['id'])
PY
```

- [ ] **Step 4: Verify the migration applies on a fresh DB** — the in-memory test DB runs all migrations on construction:

```bash
pnpm test tests/db/auth-schema.test.ts
```
Expected: FAIL — the fixture/test still says `username`. (Migration itself loads fine; the test text is what fails.) If you instead get a *migration* error ("no such column"), the SQL/snapshot is wrong — fix before continuing.

- [ ] **Step 5: Update the fixture** — `tests/helpers/fixtures.ts`, in `seedUser` change the option name and insert column from `username` to `email` (both the type `username: string` → `email: string`, the `opts.username` read, and `username: opts.username` → `email: opts.email`).

- [ ] **Step 6: Update server identity code:**
  - `server/services/sessions.ts`: in `SessionUser`, `username: string` → `email: string`; in `getSessionUser`'s select, `username: schema.users.username` → `email: schema.users.email`; in the returned object, `username: row.username` → `email: row.email`.
  - `server/api/auth/login.post.ts`: `BodySchema` field `username: z.string().min(1).max(64)` → `email: z.string().min(1).max(254)` (kept as a plain string — legacy seeded values like `super` must still authenticate); query `eq(schema.users.username, body.username)` → `eq(schema.users.email, body.email)`; returned user `username: u.username` → `email: u.email`; 401 message `'Invalid username or password'` → `'Invalid email or password'`.
  - `server/services/seed.ts`: in `SeedCredential`, `username` → `email`; the three `db.insert(...).values({ username: 'super', … })` become `email: 'super@lanka.live'` / `email: 'admin@lanka.live'` / `email: 'client@lanka.live'`; the three `creds.push({ username: 'super', … })` become `email: …` with the same address. Add an `env` field for emails — change the signature to:
    ```ts
    export async function seedInitialUsers(
      db: BetterSQLite3Database<typeof schema>,
      env: {
        super?: string; admin?: string; client?: string
        superEmail?: string; adminEmail?: string; clientEmail?: string
      } = {}
    ): Promise<SeedCredential[]>
    ```
    and use `env.superEmail ?? 'super@lanka.live'` (etc.) for each `email`.
  - `server/plugins/seed.ts`: pass the new env and update the log lines from `"${c.username}"` to `"${c.email}"`:
    ```ts
    const creds = await seedInitialUsers(useDb(), {
      super: process.env.SEED_SUPER_PASSWORD,
      admin: process.env.SEED_ADMIN_PASSWORD,
      client: process.env.SEED_CLIENT_PASSWORD,
      superEmail: process.env.SEED_SUPER_EMAIL,
      adminEmail: process.env.SEED_ADMIN_EMAIL,
      clientEmail: process.env.SEED_CLIENT_EMAIL
    })
    for (const c of creds) {
      if (c.generated) {
        // eslint-disable-next-line no-console
        console.log(`[seed] created ${c.role} "${c.email}" — generated password: ${c.password}`)
      } else {
        // eslint-disable-next-line no-console
        console.log(`[seed] created ${c.role} "${c.email}" (password from env)`)
      }
    }
    ```

- [ ] **Step 7: Update client identity code:**
  - `app/types/api.ts`: in `SessionUser`, `username: string` → `email: string`.
  - `app/stores/auth.ts`: `async login(username: string, password: string)` → `async login(email: string, password: string)`; body `this._api.login({ username, password })` → `this._api.login({ email, password })`.
  - `app/composables/useApiClient.ts`: interface `login(body: { username: string; password: string })` → `login(body: { email: string; password: string })`. (The implementation `fetch('/api/auth/login', { method: 'POST', body })` is unchanged.)
  - `app/layouts/default.vue`: `auth.user?.username` → `auth.user?.email` on lines 45 and 123.
  - `app/layouts/portal.vue`: `auth.user?.username` → `auth.user?.email` (line 24).
  - `app/pages/login.vue`: rename the ref `username` → `email`; in `submit()` call `auth.login(email.value, password.value)` and set `error.value = 'Invalid email or password'`; change the field to:
    ```vue
    <UFormField label="Email">
      <UInput
        v-model="email"
        name="email"
        type="email"
        autocomplete="username"
        size="lg"
        icon="i-lucide-mail"
        placeholder="you@company.com"
        class="w-full"
      />
    </UFormField>
    ```

- [ ] **Step 8: Update remaining tests** to the new field name (mechanical `username` → `email`):
  - `tests/api/auth-login.test.ts`: `seedUser(db, { username: 'admin', … })` → `email: 'admin'`; `authenticateUser(db, { username: 'admin', password: 'pw' })` → `{ email: 'admin', password: 'pw' }`; `result!.user.username` → `result!.user.email`; `toMatchObject({ username: 'admin' })` → `{ email: 'admin' }`; the unknown-user case `{ username: 'ghost', … }` → `{ email: 'ghost', … }`.
  - `tests/services/sessions.test.ts`: every `seedUser(db, { username: … })` → `{ email: … }`; the `toMatchObject({ … username: 'admin' … })` → `email: 'admin'`.
  - `tests/services/auth-guard.test.ts`: the two `SessionUser` literals `username: 'a'` / `username: 'c'` → `email: 'a'` / `email: 'c'`.
  - `tests/stores/auth.test.ts`: the `SessionUser` literal `username: 'admin'` → `email: 'admin'`.
  - `tests/db/auth-schema.test.ts`: all `seedUser(db, { username: … })` → `{ email: … }`; rename the last test title `'enforces unique usernames'` → `'enforces unique emails'`.
  - `tests/api/portal-stats.test.ts`: the three inline session users `{ id: 1, username: 'c', … }` → `{ id: 1, email: 'c', … }`.

- [ ] **Step 9: Run the full suite** — `pnpm test`. Expected: PASS (all existing tests green under the renamed field).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(auth): rename users.username to email (migration 0003)"
```

---

## Task 2: `password_reset_tokens` table + reset-token service

**Files:**
- Modify: `server/db/schema.ts`
- Create: migration `server/db/migrations/0004_*.sql` (+ snapshot) via `pnpm db:generate`
- Create: `server/services/password-reset.ts`
- Create: `tests/services/password-reset.test.ts`

- [ ] **Step 1: Add the table + relation to `server/db/schema.ts`** — after the `sessions` table add:

```ts
export const passwordResetTokens = sqliteTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(), // sha256(rawToken)
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    userIdx: index('password_reset_tokens_user_idx').on(t.userId)
  })
)
```
and after `sessionsRelations` add:
```ts
export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] })
}))
```

- [ ] **Step 2: Generate the migration (non-interactive — snapshot 0003 already has `email`)**

```bash
pnpm db:generate
```
Expected: creates `server/db/migrations/0004_<word>.sql` containing `CREATE TABLE \`password_reset_tokens\`` + its index, plus `meta/0004_snapshot.json`, with **no interactive prompt**. If it prompts about renaming a column, abort — snapshot 0003 from Task 1 is wrong.

- [ ] **Step 3: Write the failing test** — `tests/services/password-reset.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { createResetToken, consumeResetToken, RESET_TTL_MS } from '~/server/services/password-reset'

describe('password reset tokens', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('issues a token that consumes once to the right user', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin' })
    const token = await createResetToken(db, u.id)
    expect(await consumeResetToken(db, token)).toBe(u.id)
    // single-use: second consume fails
    expect(await consumeResetToken(db, token)).toBeNull()
  })

  it('rejects an unknown token', async () => {
    expect(await consumeResetToken(db, 'nope')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin' })
    const past = new Date(Date.now() - RESET_TTL_MS - 1000)
    const token = await createResetToken(db, u.id, past)
    expect(await consumeResetToken(db, token)).toBeNull()
  })
})
```

- [ ] **Step 4: Run it — expect FAIL** — `pnpm test tests/services/password-reset.test.ts` → FAIL ("Cannot find module '.../password-reset'").

- [ ] **Step 5: Implement `server/services/password-reset.ts`:**

```ts
import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'

export const RESET_TTL_MS = 60 * 60 * 1000 // 1 hour

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createResetToken(
  db: BetterSQLite3Database<typeof schema>,
  userId: number,
  now = new Date()
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(schema.passwordResetTokens).values({
    id: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
    createdAt: now
  })
  return token
}

/** Validates + marks the token used (single-use). Returns the userId or null. */
export async function consumeResetToken(
  db: BetterSQLite3Database<typeof schema>,
  token: string,
  now = new Date()
): Promise<number | null> {
  const [row] = await db
    .select()
    .from(schema.passwordResetTokens)
    .where(eq(schema.passwordResetTokens.id, hashToken(token)))
  if (!row) return null
  if (row.usedAt) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  await db
    .update(schema.passwordResetTokens)
    .set({ usedAt: now })
    .where(eq(schema.passwordResetTokens.id, row.id))
  return row.userId
}
```

- [ ] **Step 6: Run it — expect PASS** — `pnpm test tests/services/password-reset.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): password_reset_tokens table + reset-token service"
```

---

## Task 3: Pluggable mailer service + runtime config

**Files:**
- Create: `server/services/mailer.ts`
- Create: `tests/services/mailer.test.ts`
- Modify: `nuxt.config.ts` (runtimeConfig)
- Modify: `tests/helpers/nuxt-stubs.ts` (only if needed — see note)

- [ ] **Step 1: Write the failing test** — `tests/services/mailer.test.ts` (tests the concrete classes; `useMailer()` is exercised only by the Nitro handler, not unit-tested):

```ts
import { describe, it, expect, vi } from 'vitest'
import { LogMailer, ResendMailer } from '~/server/services/mailer'

describe('LogMailer', () => {
  it('logs the reset url and resolves', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await new LogMailer().sendPasswordReset('a@x', 'https://app/reset?token=t')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('https://app/reset?token=t'))
    spy.mockRestore()
  })
})

describe('ResendMailer', () => {
  it('POSTs to the Resend API with the from/to/link', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new ResendMailer('key_123', 'Lanka <no-reply@lanka.live>').sendPasswordReset(
      'a@x',
      'https://app/reset?token=t'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer key_123')
    const body = JSON.parse(init.body)
    expect(body.to).toBe('a@x')
    expect(body.from).toBe('Lanka <no-reply@lanka.live>')
    expect(body.text).toContain('https://app/reset?token=t')
    vi.unstubAllGlobals()
  })

  it('throws on a non-2xx Resend response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 422 })))
    await expect(
      new ResendMailer('k', 'f').sendPasswordReset('a@x', 'u')
    ).rejects.toThrow(/422/)
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** — `pnpm test tests/services/mailer.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `server/services/mailer.ts`:**

```ts
export interface MailSender {
  sendPasswordReset(to: string, resetUrl: string): Promise<void>
}

/** Dev/test default: prints the reset link to the server log (like seed passwords). */
export class LogMailer implements MailSender {
  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[mailer] password reset for ${to}: ${resetUrl}`)
  }
}

/** Production: one HTTP call to the Resend API. No SDK dependency. */
export class ResendMailer implements MailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: this.from,
        to,
        subject: 'Reset your Lanka password',
        text: `Reset your Lanka password using this link (valid 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Reset your Lanka password using this link (valid 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`
      })
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Resend API error ${res.status}: ${detail}`)
    }
  }
}

let _mailer: MailSender | null = null

/** Picks ResendMailer when RESEND_API_KEY is set, else LogMailer. */
export function useMailer(): MailSender {
  if (_mailer) return _mailer
  const config = useRuntimeConfig()
  const apiKey = config.resendApiKey as string
  const from = config.mailFrom as string
  _mailer = apiKey ? new ResendMailer(apiKey, from) : new LogMailer()
  return _mailer
}
```
Note: `useRuntimeConfig` is already stubbed (throws) in `tests/helpers/nuxt-stubs.ts`; that's fine because the tests above never call `useMailer()`.

- [ ] **Step 4: Run it — expect PASS** — `pnpm test tests/services/mailer.test.ts` → PASS.

- [ ] **Step 5: Add runtime config** — `nuxt.config.ts`, inside `runtimeConfig` (server section, NOT under `public`), after `appVersion`:

```ts
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    mailFrom: process.env.MAIL_FROM ?? 'Lanka <no-reply@lanka.live>',
    appBaseUrl: process.env.APP_BASE_URL ?? '',
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mail): pluggable MailSender (Resend + LogMailer) and runtime config"
```

---

## Task 4: `forgot-password` + `reset-password` endpoints

**Files:**
- Create: `server/api/auth/forgot-password.post.ts`
- Create: `server/api/auth/reset-password.post.ts`
- Create: `tests/api/auth-password-reset.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/api/auth-password-reset.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import * as schema from '~/server/db/schema'
import { hashPassword, verifyPassword } from '~/server/services/password'
import { createSession, getSessionUser } from '~/server/services/sessions'
import { handleForgotPassword } from '~/server/api/auth/forgot-password.post'
import { handleResetPassword } from '~/server/api/auth/reset-password.post'
import type { MailSender } from '~/server/services/mailer'

class CaptureMailer implements MailSender {
  sent: Array<{ to: string; url: string }> = []
  async sendPasswordReset(to: string, url: string) { this.sent.push({ to, url }) }
}

describe('forgot/reset password', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('emails a reset link for a known address', async () => {
    await seedUser(db, { email: 'a@x', role: 'admin', passwordHash: await hashPassword('old') })
    const mailer = new CaptureMailer()
    const res = await handleForgotPassword(db, { email: 'a@x' }, { mailer, baseUrl: 'https://app.lanka.live' })
    expect(res).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].url).toMatch(/^https:\/\/app\.lanka\.live\/reset-password\?token=.+/)
  })

  it('does not reveal unknown addresses (still 200, no email)', async () => {
    const mailer = new CaptureMailer()
    const res = await handleForgotPassword(db, { email: 'ghost@x' }, { mailer, baseUrl: 'https://app.lanka.live' })
    expect(res).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(0)
  })

  it('resets the password, consumes the token, and kills sessions', async () => {
    const u = await seedUser(db, { email: 'a@x', role: 'admin', passwordHash: await hashPassword('old') })
    const sessionToken = await createSession(db, u.id)
    const mailer = new CaptureMailer()
    await handleForgotPassword(db, { email: 'a@x' }, { mailer, baseUrl: 'https://app' })
    const resetToken = new URL(mailer.sent[0].url).searchParams.get('token')!

    const res = await handleResetPassword(db, { token: resetToken, password: 'newpassword' })
    expect(res).toEqual({ ok: true })

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id))
    expect(await verifyPassword('newpassword', row.passwordHash)).toBe(true)
    expect(await getSessionUser(db, sessionToken)).toBeNull() // existing session invalidated
    await expect(handleResetPassword(db, { token: resetToken, password: 'another1' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a short password', async () => {
    await expect(handleResetPassword(db, { token: 'x', password: 'short' })).rejects.toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** — `pnpm test tests/api/auth-password-reset.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement `server/api/auth/forgot-password.post.ts`:**

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { createResetToken } from '~/server/services/password-reset'
import { useMailer, type MailSender } from '~/server/services/mailer'

const BodySchema = z.object({ email: z.email().max(254) })

export async function handleForgotPassword(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown,
  deps: { mailer: MailSender; baseUrl: string }
): Promise<{ ok: true }> {
  const body = BodySchema.parse(rawBody)
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, body.email))
  if (u) {
    const token = await createResetToken(db, u.id)
    const resetUrl = `${deps.baseUrl}/reset-password?token=${token}`
    try {
      await deps.mailer.sendPasswordReset(u.email, resetUrl)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[forgot-password] mail send failed', e)
    }
  }
  // Always generic — never reveal whether the address exists.
  return { ok: true }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const config = useRuntimeConfig()
  try {
    return await handleForgotPassword(useDb(), body, {
      mailer: useMailer(),
      baseUrl: (config.appBaseUrl as string) || ''
    })
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
```

- [ ] **Step 4: Implement `server/api/auth/reset-password.post.ts`:**

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { consumeResetToken } from '~/server/services/password-reset'
import { hashPassword } from '~/server/services/password'

const BodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(256)
})

export async function handleResetPassword(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
): Promise<{ ok: true }> {
  const body = BodySchema.parse(rawBody)
  const userId = await consumeResetToken(db, body.token)
  if (userId === null) {
    throw createError({ statusCode: 400, message: 'Invalid or expired reset link' })
  }
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() })
    .where(eq(schema.users.id, userId))
  // Force re-login everywhere.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
  return { ok: true }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleResetPassword(useDb(), body)
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
```

- [ ] **Step 5: Run it — expect PASS** — `pnpm test tests/api/auth-password-reset.test.ts` → PASS. (Both `/api/auth/forgot-password` and `/api/auth/reset-password` are already public via the `/api/auth/` prefix in `isPublicRoute`; no auth-guard change needed.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): forgot-password + reset-password endpoints"
```

---

## Task 5: User CRUD endpoints (`/api/users`) + password generator

**Files:**
- Modify: `server/services/password.ts` (add `generatePassword`)
- Create: `server/api/users/index.get.ts`, `server/api/users/index.post.ts`, `server/api/users/[id].delete.ts`
- Create: `tests/api/users.test.ts`
- Modify: `tests/services/auth-guard.test.ts` (document `/api/users` access)

- [ ] **Step 1: Add `generatePassword` to `server/services/password.ts`** (top-level export; `randomBytes` is already imported):

```ts
/** A random, URL-safe initial password (~16 chars). */
export function generatePassword(): string {
  return randomBytes(12).toString('base64url')
}
```

- [ ] **Step 2: Write the failing test** — `tests/api/users.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedOrganization, seedUser } from '../helpers/fixtures'
import { handleListUsers } from '~/server/api/users/index.get'
import { handleCreateUser } from '~/server/api/users/index.post'
import { handleDeleteUser } from '~/server/api/users/[id].delete'
import { verifyPassword } from '~/server/services/password'
import type { SessionUser } from '~/server/services/sessions'

const asSuper = (id = 1): SessionUser => ({ id, email: 's@x', role: 'super', organizationId: null })
const asAdmin = (id = 2): SessionUser => ({ id, email: 'a@x', role: 'admin', organizationId: null })

describe('user management API', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('super creates an admin and gets a one-time password back', async () => {
    const res = await handleCreateUser(db, asSuper(), { email: 'new@admin', role: 'admin' })
    expect(res.user).toMatchObject({ email: 'new@admin', role: 'admin', organizationId: null })
    expect(res.generatedPassword.length).toBeGreaterThanOrEqual(12)
    const [row] = await db.query.users.findMany({ where: (u, { eq }) => eq(u.email, 'new@admin') })
    expect(await verifyPassword(res.generatedPassword, row.passwordHash)).toBe(true)
  })

  it('super creates a client bound to an org', async () => {
    const org = await seedOrganization(db)
    const res = await handleCreateUser(db, asSuper(), { email: 'c@x', role: 'client', organizationId: org.id })
    expect(res.user).toMatchObject({ role: 'client', organizationId: org.id })
  })

  it('rejects a client without an org (400)', async () => {
    await expect(handleCreateUser(db, asSuper(), { email: 'c@x', role: 'client' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an admin given an org (400)', async () => {
    const org = await seedOrganization(db)
    await expect(handleCreateUser(db, asSuper(), { email: 'a2@x', role: 'admin', organizationId: org.id }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('admin may create a client but not an admin (403)', async () => {
    const org = await seedOrganization(db)
    await expect(handleCreateUser(db, asAdmin(), { email: 'ok@x', role: 'client', organizationId: org.id }))
      .resolves.toBeTruthy()
    await expect(handleCreateUser(db, asAdmin(), { email: 'no@x', role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a duplicate email (409)', async () => {
    await handleCreateUser(db, asSuper(), { email: 'dup@x', role: 'admin' })
    await expect(handleCreateUser(db, asSuper(), { email: 'dup@x', role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('admin sees only clients; super sees everyone', async () => {
    const org = await seedOrganization(db)
    await seedUser(db, { email: 'admin1@x', role: 'admin' })
    await seedUser(db, { email: 'client1@x', role: 'client', organizationId: org.id })
    const adminView = await handleListUsers(db, asAdmin())
    expect(adminView.every((u) => u.role === 'client')).toBe(true)
    const superView = await handleListUsers(db, asSuper())
    expect(superView.some((u) => u.role === 'admin')).toBe(true)
    expect(superView.find((u) => u.role === 'client')?.organizationName).toBe(org.name)
  })

  it('delete: blocks self, super targets, and admin→non-client', async () => {
    const org = await seedOrganization(db)
    const adminRow = await seedUser(db, { email: 'me@x', role: 'admin' })
    const superRow = await seedUser(db, { email: 'boss@x', role: 'super' })
    const clientRow = await seedUser(db, { email: 'cli@x', role: 'client', organizationId: org.id })

    await expect(handleDeleteUser(db, { id: adminRow.id, email: 'me@x', role: 'admin', organizationId: null }, adminRow.id))
      .rejects.toMatchObject({ statusCode: 403 }) // self
    await expect(handleDeleteUser(db, asSuper(), superRow.id))
      .rejects.toMatchObject({ statusCode: 403 }) // super target
    await expect(handleDeleteUser(db, { id: adminRow.id, email: 'me@x', role: 'admin', organizationId: null }, superRow.id))
      .rejects.toMatchObject({ statusCode: 403 }) // admin→non-client
    await handleDeleteUser(db, asSuper(), clientRow.id) // allowed
    const remaining = await db.query.users.findMany({ where: (u, { eq }) => eq(u.id, clientRow.id) })
    expect(remaining).toHaveLength(0)
  })

  it('delete: 404 for a missing user', async () => {
    await expect(handleDeleteUser(db, asSuper(), 9999)).rejects.toMatchObject({ statusCode: 404 })
  })
})
```

- [ ] **Step 3: Run it — expect FAIL** — `pnpm test tests/api/users.test.ts` → FAIL (modules missing).

- [ ] **Step 4: Implement `server/api/users/index.get.ts`:**

```ts
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import type { Role, SessionUser } from '~/server/services/sessions'

export interface UserRow {
  id: number
  email: string
  role: Role
  organizationId: number | null
  organizationName: string | null
  createdAt: Date
}

export async function handleListUsers(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser
): Promise<UserRow[]> {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      organizationId: schema.users.organizationId,
      organizationName: schema.organizations.name,
      createdAt: schema.users.createdAt
    })
    .from(schema.users)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.users.organizationId))
    .orderBy(asc(schema.users.email))
  const visible = caller.role === 'super' ? rows : rows.filter((r) => r.role === 'client')
  return visible as UserRow[]
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  return handleListUsers(useDb(), caller)
})
```

- [ ] **Step 5: Implement `server/api/users/index.post.ts`:**

```ts
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import { hashPassword, generatePassword } from '~/server/services/password'
import type { SessionUser } from '~/server/services/sessions'

const BodySchema = z.object({
  email: z.email().max(254),
  role: z.enum(['admin', 'client']),
  organizationId: z.number().int().positive().optional()
})

export interface CreateUserResult {
  user: { id: number; email: string; role: 'admin' | 'client'; organizationId: number | null }
  generatedPassword: string
}

export async function handleCreateUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  rawBody: unknown
): Promise<CreateUserResult> {
  const body = BodySchema.parse(rawBody)
  if (caller.role === 'admin' && body.role !== 'client') {
    throw createError({ statusCode: 403, message: 'Admins may only create client users' })
  }
  if (body.role === 'client' && body.organizationId == null) {
    throw createError({ statusCode: 400, message: 'A client must be assigned to an organization' })
  }
  if (body.role === 'admin' && body.organizationId != null) {
    throw createError({ statusCode: 400, message: 'Admins are not tied to an organization' })
  }
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  try {
    const [row] = await db
      .insert(schema.users)
      .values({
        email: body.email,
        role: body.role,
        passwordHash,
        organizationId: body.role === 'client' ? body.organizationId! : null
      })
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        organizationId: schema.users.organizationId
      })
    return { user: row as CreateUserResult['user'], generatedPassword: password }
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createError({ statusCode: 409, message: 'A user with that email already exists' })
    }
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw createError({ statusCode: 400, message: 'Unknown organizationId' })
    }
    throw err
  }
}

export { handleListUsers } from './index.get'

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const body = await readBody(event)
  try {
    return await handleCreateUser(useDb(), caller, body)
  } catch (err: any) {
    if (err instanceof z.ZodError) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
})
```

- [ ] **Step 6: Implement `server/api/users/[id].delete.ts`:**

```ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { requireRole } from '~/server/services/auth-guard'
import type { SessionUser } from '~/server/services/sessions'

export async function handleDeleteUser(
  db: BetterSQLite3Database<typeof schema>,
  caller: SessionUser,
  id: number
): Promise<void> {
  if (caller.id === id) {
    throw createError({ statusCode: 403, message: 'You cannot delete your own account' })
  }
  const [target] = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, id))
  if (!target) throw createError({ statusCode: 404, message: `User ${id} not found` })
  if (target.role === 'super') {
    throw createError({ statusCode: 403, message: 'Super accounts cannot be deleted' })
  }
  if (caller.role === 'admin' && target.role !== 'client') {
    throw createError({ statusCode: 403, message: 'Admins may only delete client users' })
  }
  await db.delete(schema.users).where(eq(schema.users.id, id))
}

export default defineEventHandler(async (event) => {
  const caller = requireRole(event.context.user, ['admin', 'super'])
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeleteUser(useDb(), caller, id)
  setResponseStatus(event, 204)
  return null
})
```

- [ ] **Step 7: Run it — expect PASS** — `pnpm test tests/api/users.test.ts` → PASS.

- [ ] **Step 8: Add an access-policy assertion** — `tests/services/auth-guard.test.ts`, add inside the `decideAccess` describe block (matching the existing style there):

```ts
it('restricts /api/users to admin/super and 403s clients', () => {
  expect(decideAccess('/api/users', admin)).toEqual({ ok: true })
  expect(decideAccess('/api/users', client)).toEqual({ ok: false, status: 403 })
  expect(decideAccess('/api/users', null)).toEqual({ ok: false, status: 401 })
})
it('keeps the password-reset endpoints public', () => {
  expect(isPublicRoute('/api/auth/forgot-password')).toBe(true)
  expect(isPublicRoute('/api/auth/reset-password')).toBe(true)
})
```

- [ ] **Step 9: Run it — expect PASS** — `pnpm test tests/services/auth-guard.test.ts` → PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(users): CRUD endpoints with super/admin RBAC + generated passwords"
```

---

## Task 6: Client types, API client methods, and users store

**Files:**
- Modify: `app/types/api.ts`
- Modify: `app/composables/useApiClient.ts`
- Create: `app/stores/users.ts`
- Create: `tests/stores/users.test.ts`

- [ ] **Step 1: Add client types** — `app/types/api.ts`, near `SessionUser`/`Organization`:

```ts
export interface User {
  id: number
  email: string
  role: Role
  organizationId: number | null
  organizationName: string | null
  createdAt: string
}
export interface CreateUserBody {
  email: string
  role: 'admin' | 'client'
  organizationId?: number
}
export interface CreateUserResult {
  user: { id: number; email: string; role: 'admin' | 'client'; organizationId: number | null }
  generatedPassword: string
}
```

- [ ] **Step 2: Extend the API client** — `app/composables/useApiClient.ts`:
  - Add to the imports from `~/app/types/api`: `User`, `CreateUserBody`, `CreateUserResult`.
  - Add to the `ApiClient` interface (e.g. under a `// users` comment):
    ```ts
    // users
    listUsers(): Promise<User[]>
    createUser(body: CreateUserBody): Promise<CreateUserResult>
    deleteUser(id: number): Promise<void>
    // password reset
    forgotPassword(body: { email: string }): Promise<{ ok: true }>
    resetPassword(body: { token: string; password: string }): Promise<{ ok: true }>
    ```
  - Add to `createApiClient`'s returned object (after the organizations block):
    ```ts
    // users
    listUsers: () => fetch<User[]>('/api/users', { method: 'GET' }),
    createUser: (body) => fetch<CreateUserResult>('/api/users', { method: 'POST', body }),
    deleteUser: (id) => fetch<void>(`/api/users/${id}`, { method: 'DELETE' }),
    // password reset
    forgotPassword: (body) => fetch<{ ok: true }>('/api/auth/forgot-password', { method: 'POST', body }),
    resetPassword: (body) => fetch<{ ok: true }>('/api/auth/reset-password', { method: 'POST', body }),
    ```

- [ ] **Step 3: Write the failing store test** — `tests/stores/users.test.ts` (mirrors `tests/stores/auth.test.ts`):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUsersStore } from '~/app/stores/users'
import type { User } from '~/app/types/api'

const client: User = { id: 3, email: 'c@x', role: 'client', organizationId: 1, organizationName: 'Acme', createdAt: '' }

describe('users store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('refresh loads the list', async () => {
    const s = useUsersStore()
    s.$patch({ _api: {
      listUsers: async () => [client],
      createUser: async () => ({ user: { id: 9, email: 'n@x', role: 'admin', organizationId: null }, generatedPassword: 'pw' }),
      deleteUser: async () => {}
    } })
    await s.refresh()
    expect(s.list).toEqual([client])
  })

  it('create returns the one-time password and adds the row', async () => {
    const s = useUsersStore()
    s.$patch({ _api: {
      listUsers: async () => [],
      createUser: async () => ({ user: { id: 9, email: 'n@x', role: 'admin', organizationId: null }, generatedPassword: 'secret' }),
      deleteUser: async () => {}
    } })
    const pw = await s.create({ email: 'n@x', role: 'admin' })
    expect(pw).toBe('secret')
    expect(s.list.find((u) => u.id === 9)?.email).toBe('n@x')
  })

  it('remove drops the row', async () => {
    const s = useUsersStore()
    s.$patch({ list: [client], _api: {
      listUsers: async () => [client], createUser: async () => ({} as any), deleteUser: async () => {}
    } })
    await s.remove(client.id)
    expect(s.list).toHaveLength(0)
  })
})
```

- [ ] **Step 4: Run it — expect FAIL** — `pnpm test tests/stores/users.test.ts` → FAIL (store missing).

- [ ] **Step 5: Implement `app/stores/users.ts`** (mirrors `app/stores/groups.ts`):

```ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import type { CreateUserBody, User } from '~/app/types/api'

interface State {
  list: User[]
  loading: boolean
  error: string | null
  _api: Pick<ApiClient, 'listUsers' | 'createUser' | 'deleteUser'>
}

export const useUsersStore = defineStore('users', {
  state: (): State => ({ list: [], loading: false, error: null, _api: useApiClient() }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listUsers()
      } catch (e: any) {
        this.error = e?.message ?? String(e)
      } finally {
        this.loading = false
      }
    },
    /** Creates a user and returns the one-time generated password. */
    async create(body: CreateUserBody): Promise<string> {
      const { user, generatedPassword } = await this._api.createUser(body)
      this.list = [
        ...this.list,
        { ...user, organizationName: null, createdAt: new Date().toISOString() }
      ].sort((a, b) => a.email.localeCompare(b.email))
      return generatedPassword
    },
    async remove(id: number): Promise<void> {
      await this._api.deleteUser(id)
      this.list = this.list.filter((u) => u.id !== id)
    }
  }
})
```

- [ ] **Step 6: Run it — expect PASS** — `pnpm test tests/stores/users.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(users): client types, API client methods, users store"
```

---

## Task 7: Users management page + navigation

**Files:**
- Create: `app/pages/users/index.vue`
- Modify: `app/layouts/default.vue` (nav)

- [ ] **Step 1: Create `app/pages/users/index.vue`** (follows the `organizations/index.vue` + `PageHeader` + `useConfirm` patterns; role-aware create form; one-time password dialog):

```vue
<script setup lang="ts">
definePageMeta({ layout: 'default' })
const usersStore = useUsersStore()
const orgsStore = useOrganizationsStore()
const auth = useAuthStore()
const confirm = useConfirm()
const toast = useToast()

const email = ref('')
const role = ref<'admin' | 'client'>('client')
const organizationId = ref<number | null>(null)
const creating = ref(false)
const generated = ref<{ email: string; password: string } | null>(null)

const roleOptions = computed(() =>
  auth.role === 'super'
    ? [{ label: 'Admin', value: 'admin' }, { label: 'Client', value: 'client' }]
    : [{ label: 'Client', value: 'client' }]
)
const orgOptions = computed(() =>
  orgsStore.list.map((o) => ({ label: o.name, value: o.id }))
)

onMounted(() => {
  usersStore.refresh()
  orgsStore.refresh()
})

function canDelete(u: { id: number; role: string }) {
  return u.id !== auth.user?.id && u.role !== 'super'
}

async function add() {
  if (!email.value.trim()) return
  if (role.value === 'client' && organizationId.value == null) {
    toast.add({ title: 'Pick an organization for the client', color: 'warning' })
    return
  }
  creating.value = true
  try {
    const password = await usersStore.create({
      email: email.value.trim(),
      role: role.value,
      organizationId: role.value === 'client' ? organizationId.value! : undefined
    })
    generated.value = { email: email.value.trim(), password }
    email.value = ''
    organizationId.value = null
  } catch (e: any) {
    toast.add({ title: 'Could not create user', description: e?.data?.message ?? e?.message, color: 'error' })
  } finally {
    creating.value = false
  }
}

async function remove(u: { id: number; email: string; role: string }) {
  if (!canDelete(u)) return
  const ok = await confirm({
    title: `Delete ${u.email}?`,
    description: 'Their sessions end immediately. This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await usersStore.remove(u.id)
  } catch (e: any) {
    toast.add({ title: 'Could not delete user', description: e?.data?.message ?? e?.message, color: 'error' })
  }
}

async function copyPassword() {
  if (generated.value) await navigator.clipboard.writeText(generated.value.password)
  toast.add({ title: 'Password copied', color: 'success' })
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      title="Users"
      subtitle="Create admins and client accounts. Clients see only their organization's portal."
      icon="i-lucide-users"
    />

    <div class="soft-card mb-6 grid gap-3 p-5 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
      <UFormField label="Email">
        <UInput v-model="email" type="email" placeholder="person@company.com" size="lg" class="w-full" @keyup.enter="add" />
      </UFormField>
      <UFormField label="Role">
        <USelect v-model="role" :items="roleOptions" value-key="value" size="lg" class="w-40" />
      </UFormField>
      <UFormField v-if="role === 'client'" label="Organization">
        <USelect v-model="organizationId" :items="orgOptions" value-key="value" placeholder="Select…" size="lg" class="w-48" />
      </UFormField>
      <UButton color="primary" size="lg" :loading="creating" @click="add">Create</UButton>
    </div>

    <div class="soft-card divide-y divide-(--ui-border)">
      <div
        v-for="u in usersStore.list"
        :key="u.id"
        class="flex items-center gap-3.5 p-4"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
          {{ u.email.slice(0, 2).toUpperCase() }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium text-(--ui-text-highlighted)">{{ u.email }}</p>
          <p class="text-xs text-(--ui-text-muted)">
            <span class="capitalize">{{ u.role }}</span>
            <span v-if="u.organizationName"> · {{ u.organizationName }}</span>
          </p>
        </div>
        <UButton
          v-if="canDelete(u)"
          variant="ghost" color="error" size="sm" icon="i-lucide-trash-2"
          :aria-label="`Delete ${u.email}`"
          @click="remove(u)"
        />
      </div>
      <p v-if="!usersStore.loading && usersStore.list.length === 0" class="p-4 text-(--ui-text-muted)">
        No users yet.
      </p>
    </div>

    <!-- One-time generated-password reveal -->
    <UModal :open="generated !== null" title="Account created" @update:open="(v) => { if (!v) generated = null }">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">
          Share this one-time password with <span class="font-medium text-(--ui-text)">{{ generated?.email }}</span>.
          It is shown only once — they can change it later via “Forgot password”.
        </p>
        <div class="mt-4 flex items-center gap-2 rounded-xl bg-(--ui-bg-elevated) p-3">
          <code class="flex-1 font-mono text-sm">{{ generated?.password }}</code>
          <UButton size="sm" icon="i-lucide-copy" @click="copyPassword">Copy</UButton>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="soft" @click="generated = null">Done</UButton>
      </template>
    </UModal>
  </div>
</template>
```

- [ ] **Step 2: Add the nav item** — `app/layouts/default.vue`, in `navGroups` replace the `Organization` group with a combined `People` group (keeps Organizations, adds Users):

```ts
  {
    label: 'People',
    items: [
      { label: 'Users', icon: 'i-lucide-users', to: '/users' },
      { label: 'Organizations', icon: 'i-lucide-briefcase', to: '/organizations' }
    ]
  }
```

- [ ] **Step 3: Type-check the build** (pages aren't unit-tested in this repo; the build is the gate):

```bash
pnpm build
```
Expected: build succeeds with no type errors. If `UModal`/`USelect` prop names differ in this Nuxt UI version, adjust per the error message (e.g. `:items` vs `:options`).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(users): management page + nav entry"
```

---

## Task 8: Public forgot/reset pages + login wiring

**Files:**
- Create: `app/pages/forgot-password.vue`, `app/pages/reset-password.vue`
- Modify: `app/middleware/auth.global.ts` (exempt the two public pages)
- Modify: `app/pages/login.vue` (add "Forgot password?" link)

- [ ] **Step 1: Exempt the public pages** — `app/middleware/auth.global.ts`, add a public-path set and short-circuit before the auth checks:

```ts
export default defineNuxtRouteMiddleware(async (to) => {
  const PUBLIC = new Set(['/login', '/forgot-password', '/reset-password'])
  if (PUBLIC.has(to.path)) {
    const auth = useAuthStore()
    if (!auth.ready) await auth.fetchMe()
    // already signed in? bounce away from public auth pages
    if (auth.isAuthenticated) {
      return navigateTo(auth.role === 'client' ? '/portal' : '/')
    }
    return
  }
  const auth = useAuthStore()
  if (!auth.ready) await auth.fetchMe()
  if (!auth.isAuthenticated) return navigateTo('/login')
  if (auth.role === 'client' && !to.path.startsWith('/portal')) return navigateTo('/portal')
  if (auth.role !== 'client' && to.path.startsWith('/portal')) return navigateTo('/')
})
```

- [ ] **Step 2: Create `app/pages/forgot-password.vue`:**

```vue
<script setup lang="ts">
definePageMeta({ layout: false })
const api = useApiClient()
const email = ref('')
const sent = ref(false)
const loading = ref(false)

async function submit() {
  loading.value = true
  try {
    await api.forgotPassword({ email: email.value.trim() })
  } finally {
    loading.value = false
    sent.value = true // always show the same confirmation (anti-enumeration)
  }
}
</script>

<template>
  <div class="canvas-bg flex min-h-screen items-center justify-center p-8">
    <div class="reveal w-full max-w-sm">
      <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">Reset password</h1>
      <template v-if="!sent">
        <p class="mt-2 text-sm text-(--ui-text-muted)">Enter your email and we'll send a reset link.</p>
        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField label="Email">
            <UInput v-model="email" type="email" name="email" autocomplete="username" size="lg" icon="i-lucide-mail" placeholder="you@company.com" class="w-full" />
          </UFormField>
          <UButton type="submit" block size="lg" color="primary" :loading="loading">Send reset link</UButton>
        </form>
      </template>
      <p v-else class="mt-2 text-sm text-(--ui-text-muted)">
        If an account exists for <span class="font-medium text-(--ui-text)">{{ email }}</span>, a reset link is on its way. The link is valid for one hour.
      </p>
      <NuxtLink to="/login" class="mt-8 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">← Back to sign in</NuxtLink>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Create `app/pages/reset-password.vue`:**

```vue
<script setup lang="ts">
definePageMeta({ layout: false })
const api = useApiClient()
const route = useRoute()
const token = computed(() => String(route.query.token ?? ''))
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)
const done = ref(false)

async function submit() {
  error.value = null
  if (password.value.length < 8) {
    error.value = 'Password must be at least 8 characters.'
    return
  }
  loading.value = true
  try {
    await api.resetPassword({ token: token.value, password: password.value })
    done.value = true
    setTimeout(() => navigateTo('/login'), 1500)
  } catch {
    error.value = 'This reset link is invalid or has expired. Request a new one.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="canvas-bg flex min-h-screen items-center justify-center p-8">
    <div class="reveal w-full max-w-sm">
      <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">Set a new password</h1>
      <template v-if="!done">
        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField label="New password">
            <UInput v-model="password" type="password" name="new-password" autocomplete="new-password" size="lg" icon="i-lucide-lock" placeholder="At least 8 characters" class="w-full" />
          </UFormField>
          <div v-if="error" class="flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2.5 text-sm font-medium text-rose-600 dark:text-rose-400">
            <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" /><span>{{ error }}</span>
          </div>
          <UButton type="submit" block size="lg" color="primary" :loading="loading">Update password</UButton>
        </form>
        <NuxtLink to="/forgot-password" class="mt-6 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">Request a new link</NuxtLink>
      </template>
      <p v-else class="mt-2 text-sm text-(--ui-text-muted)">Password updated. Redirecting to sign in…</p>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Add the "Forgot password?" link** — `app/pages/login.vue`, immediately after the Password `</UFormField>` (before the error block):

```vue
          <div class="flex justify-end">
            <NuxtLink to="/forgot-password" class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Forgot password?</NuxtLink>
          </div>
```

- [ ] **Step 5: Build** — `pnpm build`. Expected: succeeds, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): public forgot/reset pages + login link + guard exemptions"
```

---

## Task 9: Seed emails, env, and docs

**Files:**
- Modify: `tests/services/seed.test.ts`
- Modify: `.env`, `.env.example` (if present)
- Modify: `CLAUDE.md` (dev-login table), `README.md` (endpoints, env, DNS/ops)

- [ ] **Step 1: Update the seed test** to assert email-shaped seed identities — `tests/services/seed.test.ts`, first test, after `expect(users).toHaveLength(3)` add:

```ts
    expect(users.map((u) => u.email).sort()).toEqual(['admin@lanka.live', 'client@lanka.live', 'super@lanka.live'])
```
(The `seedInitialUsers(db, { super: 'spw', … })` calls keep working — those keys are passwords; emails default to `*@lanka.live` unless `superEmail`/etc. are passed.)

- [ ] **Step 2: Run the seed test — expect PASS** — `pnpm test tests/services/seed.test.ts`. (If it fails because Task 1's seed edit defaulted to different addresses, reconcile the addresses here.)

- [ ] **Step 3: Update `.env`** — set known dev emails alongside the existing `SEED_*_PASSWORD=lanka-dev`:

```bash
SEED_SUPER_EMAIL=super@lanka.live
SEED_ADMIN_EMAIL=admin@lanka.live
SEED_CLIENT_EMAIL=client@lanka.live
# Email reset (dev: leave RESEND_API_KEY empty → links print to the server log)
RESEND_API_KEY=
MAIL_FROM=Lanka <no-reply@lanka.live>
APP_BASE_URL=http://localhost:5100
```
If `.env.example` exists, add the same keys there with empty/placeholder values (and `APP_BASE_URL=https://app.lanka.live` as the prod hint).

- [ ] **Step 4: Update `CLAUDE.md`** — in the "Dev login (seed accounts)" table, change the `username` column header to `email` and the values to `super@lanka.live` / `admin@lanka.live` / `client@lanka.live`. Add one line under the table noting email is now the login identity and that `SEED_*_EMAIL` overrides the defaults.

- [ ] **Step 5: Update `README.md`:**
  - Endpoints: add `GET/POST /api/users`, `DELETE /api/users/:id`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`.
  - Env: document `RESEND_API_KEY`, `MAIL_FROM`, `APP_BASE_URL`, `SEED_*_EMAIL`.
  - Ops/DNS: a short "Email (password reset)" note — set Resend SPF/DKIM records on `lanka.live` and verify the sending domain; set `RESEND_API_KEY`, `MAIL_FROM`, and `APP_BASE_URL=https://app.lanka.live`; without `RESEND_API_KEY` the app logs reset links instead of sending. Note the nginx public block should rate-limit `POST /api/auth/forgot-password` like `/api/auth/login`.

- [ ] **Step 6: Run the full suite** — `pnpm test`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs+seed: email login identity, reset env, README/CLAUDE updates"
```

---

## Task 10: Full verification & manual smoke

- [ ] **Step 1: Full test suite + build**

```bash
pnpm test && pnpm build
```
Expected: all tests PASS; build succeeds.

- [ ] **Step 2: Apply migrations to the dev DB** (or delete `data/signage.db` to reseed with email identities):

```bash
pnpm db:migrate
```
Expected: migrations `0003` (rename) and `0004` (reset table) apply cleanly. If the dev DB predates users, deleting `data/signage.db` then starting the app reseeds `*@lanka.live`.

- [ ] **Step 3: Manual smoke** — `PORT=5100 pnpm dev`, then verify:
  - Sign in as `super@lanka.live` / `lanka-dev`. "Users" appears in the nav.
  - Create an admin → one-time password dialog shows; the new admin appears in the list; copy works.
  - Create a client → organization select is required; row shows the org name.
  - Delete a client (confirm dialog); the self/super rows have no delete button.
  - Sign in as `admin@lanka.live` → "Users" shows only clients; the role select offers only "Client".
  - Visit `/forgot-password`, submit `client@lanka.live`; the dev server log prints `[mailer] password reset for client@lanka.live: http://localhost:5100/reset-password?token=…`. Open that URL, set a new password, confirm redirect to `/login`, and sign in with the new password.

- [ ] **Step 4: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "fix: user-management smoke-test adjustments"
```

---

## Self-review notes (for the planner)

- **Spec coverage:** §1 permission model → Tasks 5/7; §2 identity rename → Task 1; §3 user CRUD → Tasks 5/6/7; §4 reset (table/service/endpoints/mailer/env) → Tasks 2/3/4; §5 frontend → Tasks 6/7/8; §6 testing → embedded per task; §7 rollout/DNS → Task 9. Migration sequencing (rename hand-authored 0003, then `db:generate` 0004) keeps every `db:generate` non-interactive.
- **No auth-guard code change** is required: `/api/users` falls under the existing admin/super branch of `decideAccess`, and the reset endpoints are already public via `/api/auth/`. Task 5 adds assertions documenting this.
- **Type consistency:** `email` replaces `username` in `SessionUser` (server + client), `seedUser` fixture, login body, and all session/auth tests (Task 1). `CreateUserResult`/`UserRow` shapes match between `server/api/users/*` and `app/types/api.ts`.
- **One-time password:** generated server-side (`generatePassword`), returned only from `POST /api/users`, surfaced once via the modal; never re-fetchable (list endpoint omits the hash).
