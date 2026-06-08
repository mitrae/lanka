# Lanka — User Management + Email Password Reset (Design)

**Date:** 2026-06-08
**Status:** Approved, ready for implementation planning
**Scope:** One combined spec covering (a) super/admin user management CRUD and (b) self-service password reset by email, with email as the login identity.

## Goal

Let operators manage accounts from the dashboard instead of editing the DB:

- `super` creates/deletes **admin** and **client** accounts.
- `admin` creates/deletes **client** accounts (assigning each to an organization).
- Every user logs in with their **email**, and can reset a forgotten password via an emailed link.

## Non-goals (explicitly out of scope)

Create + delete only. The following are **not** included:

- Renaming a user, changing a user's role, reassigning a client's organization, or editing an email after creation.
- Any management of `super` accounts through the UI/API (seed-only; change via DB if ever needed).
- Admin management of other admins or supers.
- Email verification on signup, invitation/"set your password" flows (creation uses a generated password instead), 2FA, or audit logging.

## Decisions (from brainstorming)

1. **Who manages users:** super manages admins + clients; admin manages clients only. Client unchanged (portal only).
2. **Edit scope:** create + delete only (plus self-service password reset).
3. **Initial password:** server-generated, returned in the create response and shown **once** in the UI. Never stored in plaintext.
4. **Super accounts:** not manageable via UI/API. Seed-only.
5. **Identity:** replace `username` with `email` as the single unique login identifier.
6. **Password reset:** self-service via email, combined into this spec.
7. **Email delivery:** Resend HTTP API in production; a pluggable log-only mailer in dev/test.

---

## 1. Permission model

| Actor   | Capabilities                                                                 |
|---------|------------------------------------------------------------------------------|
| `super` | Create/delete admins; create/delete clients (with org); list **all** users   |
| `admin` | Create/delete clients only (with org); list **clients** only                 |
| `client`| No user management (portal only — unchanged)                                 |

Hard rules enforced server-side (return `403` unless noted):

- The API **never** creates or deletes a `super` (attempt → 403).
- A caller **cannot delete their own account** (→ 403).
- `admin` callers may only create/delete users with role `client` (→ 403 otherwise).
- Role/org integrity (already a DB `CHECK`, also validated in the handler for a clean `400`):
  `client` ⇒ `organizationId` required; `admin`/`super` ⇒ `organizationId` must be null.

---

## 2. Identity change: `username` → `email`

### Schema / migration

- Rename `users.username` → `users.email` (rename-in-place). The unique index `users_username_idx` becomes `users_email_idx`. The `users_role_org_chk` check constraint is unaffected (it references role/organization_id only).
- Generated via `pnpm db:generate`; applied by the existing entrypoint `drizzle-kit migrate`.

### Behavior

- Login matches the `email` string. **Existing seeded values** (`super`, `admin`, `client`) are preserved verbatim, so current logins keep working; only **newly created** accounts are validated as emails (`z.email()`).
- Rename propagates through the codebase:
  - `server/services/sessions.ts`: `SessionUser.username` → `SessionUser.email`; the select in `getSessionUser`.
  - `server/api/auth/login.post.ts`: request body field `username` → `email`; `authenticateUser` query/return.
  - `server/api/auth/me.get.ts`: returned user shape.
  - `app/types/api.ts`: `SessionUser` type.
  - `app/stores/auth.ts`: `login(email, password)`.
  - `app/layouts/default.vue` + `app/pages/login.vue`: field labels, `initials` derived from email.
  - `tests/`: any fixture using `username`.

### Seed

- `server/services/seed.ts` (empty DB only) creates `super@lanka.live` / `admin@lanka.live` / `client@lanka.live`, each overridable via new env `SEED_SUPER_EMAIL` / `SEED_ADMIN_EMAIL` / `SEED_CLIENT_EMAIL` (defaults as listed). Passwords still from `SEED_*_PASSWORD` or generated-and-logged.
- Update `.env` (dev: known emails + `lanka-dev` passwords), the **CLAUDE.md** dev-login table, and **README** accordingly.

---

## 3. User CRUD — server (`server/api/users/`)

Follows the established `handleXxx(db, …)` + `defineEventHandler` + Zod pattern. Handlers are unit-testable in isolation; the event handler does auth + error mapping.

### `GET /api/users` — `index.get.ts`
- `requireRole(['admin','super'])`.
- super → all users; admin → only `role = 'client'`.
- Row shape: `{ id, email, role, organizationId, organizationName | null, createdAt }`. **Never** returns `passwordHash`.

### `POST /api/users` — `index.post.ts`
- `requireRole(['admin','super'])`.
- Body: `{ email: z.email(), role: 'admin' | 'client', organizationId?: number }`.
- Rules:
  - `admin` caller may only create `role: 'client'` (else 403).
  - `client` ⇒ `organizationId` required and must reference an existing org; `admin` ⇒ `organizationId` must be absent.
  - Duplicate email (unique index violation, `SQLITE_CONSTRAINT_UNIQUE`) → **409**.
  - Unknown `organizationId` (`SQLITE_CONSTRAINT_FOREIGNKEY`) → **400**.
- Server **generates a password** (`randomBytes(12).toString('base64url')`, same primitive as seed), hashes it via `hashPassword`, inserts the user, and returns:
  `{ user: { id, email, role, organizationId }, generatedPassword: string }` — plaintext present **only** in this response.

### `DELETE /api/users/:id` — `[id].delete.ts`
- `requireRole(['admin','super'])`.
- Guards: target must exist (404); target is not `super` (403); target is not the caller (403); `admin` callers may only delete `client`s (403).
- Deletes the user; sessions cascade via existing FK (`sessions.userId onDelete: cascade`). Returns `204`.

### RBAC wiring (`server/services/auth-guard.ts`)
- `decideAccess`: paths under `/api/users` require `role ∈ {admin, super}` (the same branch as the rest of the dashboard API — no change needed beyond confirming `/api/users` is **not** matched by the portal branch). Per-role/per-row restrictions live in the handlers.

---

## 4. Password reset — server

### New table `password_reset_tokens` (schema.ts)
Mirrors the `sessions` design:
- `id: text` — PK, = `sha256(rawToken)` (raw token only ever lives in the emailed URL).
- `userId: integer` — FK → `users.id`, `onDelete: cascade`.
- `expiresAt: integer (timestamp_ms)` — TTL **1 hour**.
- `usedAt: integer (timestamp_ms) | null` — set on successful reset (single-use).
- `createdAt: integer (timestamp_ms)` default now.
- Index on `userId`.

### `POST /api/auth/forgot-password` — `server/api/auth/forgot-password.post.ts`
- Public (already covered by `/api/auth/*` in `isPublicRoute`).
- Body: `{ email: z.email() }`.
- **Always** responds `200 { ok: true }` with a generic message (anti-enumeration), regardless of whether the email exists.
- If the email matches a user: create a reset token, persist its hash, and send the email via the mailer. Best-effort — a mail send failure is logged but does not change the response.

### `POST /api/auth/reset-password` — `server/api/auth/reset-password.post.ts`
- Public.
- Body: `{ token: string, password: z.string().min(8).max(256) }`.
- Looks up `sha256(token)`; rejects if missing / expired / already used → `400` generic ("invalid or expired reset link").
- On success: set new `passwordHash`, set token `usedAt`, and **delete all sessions for that user** (force re-login everywhere). Returns `200 { ok: true }`.

### Mailer service (`server/services/mailer.ts`)
Pluggable, mirroring the `MediaStore` interface pattern:
- `interface MailSender { sendPasswordReset(to: string, resetUrl: string): Promise<void> }`.
- `LogMailer` — prints `[mailer] password reset for <to>: <resetUrl>` to the server log. Default in dev/test.
- `ResendMailer` — used when `RESEND_API_KEY` is set; one `fetch` POST to the Resend API (`from = MAIL_FROM`, subject + minimal HTML/text body containing `resetUrl`). No SDK dependency required (plain `fetch`).
- `useMailer()` picks `ResendMailer` when `RESEND_API_KEY` is present, else `LogMailer` — same selection style as `useMediaStore()`.
- Reset URL: `${APP_BASE_URL}/reset-password?token=<rawToken>`.

### Env / runtimeConfig
New runtime config (and `.env.example` / README): `RESEND_API_KEY`, `MAIL_FROM` (e.g. `Lanka <no-reply@lanka.live>`), `APP_BASE_URL` (e.g. `https://app.lanka.live`). Wired through `runtimeConfig` (server-only; not exposed to the SPA bundle).

### nginx
Add a rate-limit for `POST /api/auth/forgot-password` in the public server block, mirroring the existing `/api/auth/login` limit. (Operational config; documented in README/ops.)

---

## 5. Frontend

### Auth-guarded users page — `app/pages/users/index.vue`
- Lives in the **default** layout (already restricted to super/admin; clients are forced to `/portal`).
- Lists users from a new `users` store. Columns: email, role badge, organization (clients), created.
- **Create form:** email input; role `USelect` (admin caller → only `Client`; super → `Admin` + `Client`); organization `USelect` shown **only** when role = `client` (required), sourced from the existing organizations store.
- On successful create, open a **one-time password dialog**: shows the `generatedPassword`, with copy-to-clipboard and a clear "this is shown only once" note.
- **Delete:** existing `ConfirmDialog` / `useConfirm`. Delete button hidden/disabled for the current user and for any `super` row.
- Role visibility: an `admin` viewer only ever sees `client` rows (server-enforced); the create form hides the `Admin` option for them.

### Navigation — `app/layouts/default.vue`
- Add a nav group **"People"** with item **"Users"** (`/users`, e.g. icon `i-lucide-users`). Shown to all dashboard (super/admin) users.

### Public reset pages
- `app/pages/forgot-password.vue` — email input → `forgotPassword`; always shows the same generic "check your email" confirmation.
- `app/pages/reset-password.vue` — reads `?token=`; new-password input → `resetPassword`; on success redirect to `/login` with a success toast; on failure show "invalid or expired link" with a link back to `/forgot-password`.
- `app/middleware/auth.global.ts` — exempt `/forgot-password` and `/reset-password` from the unauth→`/login` redirect (same treatment as `/login`).
- `app/pages/login.vue` — add a "Forgot password?" link to `/forgot-password`; rename the username field to email.

### Client plumbing
- `app/composables/useApiClient.ts` — add: `listUsers()`, `createUser(body)`, `deleteUser(id)`, `forgotPassword(body)`, `resetPassword(body)`. Update `login` body field `username` → `email`.
- `app/stores/users.ts` — `_api`-pattern store: `list`, `loading`, `error`, `refresh()`, `create()` (returns the generated password to the caller for the dialog), `remove()`.
- `app/types/api.ts` — add `User` (`{ id, email, role, organizationId, organizationName?, createdAt }`) and `CreateUserResult` (`{ user, generatedPassword }`); rename `SessionUser.username` → `email`.

---

## 6. Testing (Vitest, `pool: 'forks'`)

- **User handlers:** create/delete RBAC matrix (admin↔client boundaries, no-super, no-self-delete), org-required-for-client / org-forbidden-for-admin, duplicate-email → 409, unknown org → 400, generated password returned once and never re-fetchable.
- **Reset flow:** token create → valid reset → token now single-use; expired token rejected; anti-enumeration (forgot-password returns 200 for unknown email and sends nothing); successful reset invalidates existing sessions. Tests inject `LogMailer` (or a capture spy) — no network.
- **Auth rename:** update existing login/session/me tests to `email`.
- `tests/helpers/nuxt-stubs.ts` — add any new Nitro auto-imports introduced by the new server files.

---

## 7. Rollout / operational notes

- `pnpm db:generate` produces two migrations (column rename; new `password_reset_tokens` table); `pnpm db:migrate` runs on deploy via the entrypoint.
- **DNS (operational, not code):** add Resend SPF/DKIM records on `lanka.live` and verify the sending domain so reset emails deliver. Document in README.
- The dashboard is publicly reachable at `app.lanka.live` (Cloudflare Tunnel), so emailed `app.lanka.live/reset-password?token=…` links work for clients without tailnet access.

---

## File-change summary

**Schema/migrations:** `server/db/schema.ts` (rename column + new table), generated migration files.

**Server (new):** `server/api/users/index.get.ts`, `index.post.ts`, `[id].delete.ts`; `server/api/auth/forgot-password.post.ts`, `reset-password.post.ts`; `server/services/mailer.ts`.

**Server (edit):** `server/services/sessions.ts`, `server/services/seed.ts`, `server/services/auth-guard.ts`, `server/api/auth/login.post.ts`, `server/api/auth/me.get.ts`, `nuxt.config.ts` (runtimeConfig).

**Frontend (new):** `app/pages/users/index.vue`, `app/pages/forgot-password.vue`, `app/pages/reset-password.vue`, `app/stores/users.ts`.

**Frontend (edit):** `app/composables/useApiClient.ts`, `app/types/api.ts`, `app/stores/auth.ts`, `app/layouts/default.vue`, `app/pages/login.vue`, `app/middleware/auth.global.ts`.

**Config/docs:** `.env`, `.env.example`, `CLAUDE.md` (dev-login table), `README.md` (endpoints, env, DNS, ops), nginx public block.

**Tests:** new handler/flow tests under `tests/`; updates to existing auth tests; `tests/helpers/nuxt-stubs.ts`.
