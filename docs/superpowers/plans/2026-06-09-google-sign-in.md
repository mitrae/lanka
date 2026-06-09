# Google Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Sign in with Google" to the dashboard login as an additional auth path for already-provisioned users, verifying the Google ID-token server-side and reusing the existing session machinery.

**Architecture:** Frontend renders Google Identity Services (GIS) button → browser gets a signed ID-token (JWT) → POSTs it to `POST /api/auth/google` → server verifies the JWT against Google's public keys (audience = our public Client ID), requires `email_verified`, matches an **existing** user by lowercased email, then mints the normal `lanka_session` cookie via the existing `createSession`. No auto-provisioning, no client secret, no schema change. Verification is dependency-injected so tests never hit the network or load the SDK.

**Tech Stack:** Nuxt 4 (SPA, `ssr: false`) · Nitro · Drizzle/better-sqlite3 · Pinia · Zod · `google-auth-library` (server-only, lazy-loaded) · Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-09-google-sign-in-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `server/services/google-auth.ts` | **New.** `verifyGoogleIdToken(idToken, clientId)` — lazy-imports `google-auth-library`, verifies the JWT, returns `{ email, emailVerified } | null`. |
| `server/api/auth/google.post.ts` | **New.** Exports pure `handleGoogleLogin(db, rawBody, deps)` (testable, DI verify fn) + the Nitro default handler that wires the real verifier + config + cookie. |
| `nuxt.config.ts` | Add `runtimeConfig.public.googleClientId` from `process.env.GOOGLE_CLIENT_ID`. |
| `app/composables/useApiClient.ts` | Add `loginWithGoogle({ credential })` → `POST /api/auth/google`. |
| `app/stores/auth.ts` | Add `loginWithGoogle(credential)` action; extend `_api` Pick type. |
| `app/pages/login.vue` | Render GIS button (only when Client ID configured); call the store action. |
| `Dockerfile`, `docker-compose.yml` | Add `GOOGLE_CLIENT_ID` build ARG → ENV (mirror `MEDIA_PUBLIC_BASE`). |
| `.env.example`, `README.md` | Document `GOOGLE_CLIENT_ID` + build-time bake + Google Cloud setup. |
| `tests/services/google-auth.test.ts` | **New.** Unit-test `handleGoogleLogin` with a stub verify fn. |
| `tests/stores/auth.test.ts` | Add a `loginWithGoogle` store test; update existing `_api` patches. |
| `tests/helpers/nuxt-stubs.ts` | No change expected (handler tests call `handleGoogleLogin` directly; verify by grep in Task 2). |

**Build order:** dependency → config → server verifier → server handler+tests → API client → store+tests → login UI → Docker/env/README docs.

---

### Task 1: Add the `google-auth-library` dependency

**Files:**
- Modify: `package.json` (via pnpm)

- [ ] **Step 1: Install the package**

Run:
```bash
pnpm add google-auth-library
```
Expected: `package.json` `dependencies` gains `"google-auth-library": "^<version>"`; `pnpm-lock.yaml` updates; install succeeds.

- [ ] **Step 2: Verify it resolves**

Run:
```bash
node -e "console.log(require.resolve('google-auth-library'))"
```
Expected: prints a path under `node_modules/google-auth-library/` (no error).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add google-auth-library for Google ID-token verification"
```

---

### Task 2: Add `googleClientId` to runtime config

**Files:**
- Modify: `nuxt.config.ts:58-63` (the `public: { ... }` block)

- [ ] **Step 1: Add the public config key**

In `nuxt.config.ts`, change the `public` block to:

```ts
    public: {
      // Public CDN base for media (e.g. https://media.lanka.live). Baked at
      // build time via the Dockerfile ARG because this is an SPA (ssr:false).
      // Empty in dev → the player falls back to the relative /media/<sha> path.
      mediaPublicBase: process.env.MEDIA_PUBLIC_BASE ?? '',
      // Google OAuth public Client ID for "Sign in with Google". Public by
      // design (not a secret). Plain GOOGLE_CLIENT_ID name — mirrors
      // MEDIA_PUBLIC_BASE: read here at build time and baked into the SPA via
      // the Dockerfile ARG. NOT NUXT_PUBLIC_* — SPA public values are frozen at
      // build time, so a runtime override can't reach the client bundle.
      // Empty ⇒ the Google button is hidden; password login is unaffected.
      googleClientId: process.env.GOOGLE_CLIENT_ID ?? ''
    }
```

- [ ] **Step 2: Verify the config parses and exposes the key**

Run:
```bash
GOOGLE_CLIENT_ID=test-cid.apps.googleusercontent.com pnpm exec nuxt prepare && grep -rq "googleClientId" .nuxt/ 2>/dev/null && echo "OK: googleClientId in generated types" || echo "check .nuxt manually"
```
Expected: `nuxt prepare` completes without error and prints `OK: googleClientId in generated types` (the generated runtime-config types include the new key).

- [ ] **Step 3: Confirm no Nitro stub change is needed**

`handleGoogleLogin` (Task 4) takes `clientId` via `deps`, so it never calls `useRuntimeConfig()`. Confirm the existing stub already throws for `useRuntimeConfig`:

Run:
```bash
grep -n "useRuntimeConfig" tests/helpers/nuxt-stubs.ts
```
Expected: line shows `;(globalThis as any).useRuntimeConfig = notInTests('useRuntimeConfig')` — already present, no edit required.

- [ ] **Step 4: Commit**

```bash
git add nuxt.config.ts
git commit -m "config: expose public.googleClientId (build-time, plain GOOGLE_CLIENT_ID)"
```

---

### Task 3: Server verifier service (`verifyGoogleIdToken`)

**Files:**
- Create: `server/services/google-auth.ts`

This module **must not** statically import `google-auth-library` — load it via dynamic `import()` inside the function (mirrors `R2Store`'s lazy `@aws-sdk` load), so importing this module in tests/dev never pulls in the SDK.

- [ ] **Step 1: Write the verifier**

Create `server/services/google-auth.ts`:

```ts
// server/services/google-auth.ts
//
// Verifies a Google Identity Services ID token (JWT) server-side.
// `google-auth-library` is loaded via dynamic import() so that importing this
// module (e.g. from tests via google.post.ts) never loads the SDK — it only
// loads when a token is actually verified. Mirrors R2Store's lazy @aws-sdk load.

export type GoogleIdentity = {
  email: string
  emailVerified: boolean
}

/**
 * Verify a Google ID token. Returns the identity on success, or `null` for ANY
 * verification failure (bad signature, wrong audience, wrong issuer, expired,
 * malformed, missing email). Never throws for verification failures.
 *
 * @param idToken  the `credential` JWT from GIS
 * @param clientId the OAuth Client ID used as the expected `aud`
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string
): Promise<GoogleIdentity | null> {
  if (!idToken || !clientId) return null
  try {
    const { OAuth2Client } = await import('google-auth-library')
    const client = new OAuth2Client(clientId)
    const ticket = await client.verifyIdToken({ idToken, audience: clientId })
    const payload = ticket.getPayload()
    if (!payload || !payload.email) return null
    return {
      email: payload.email,
      emailVerified: payload.email_verified === true
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Verify it imports without loading the SDK**

Run:
```bash
node --input-type=module -e "import('./server/services/google-auth.ts').catch(e=>{console.error(e);process.exit(1)})" 2>/dev/null && echo "imports clean" || pnpm exec tsx -e "import('./server/services/google-auth.ts').then(()=>console.log('imports clean'))"
```
Expected: prints `imports clean` (module evaluates with no SDK load, no error). If your environment can't run `.ts` directly, rely on Task 4's tests to exercise the import graph instead.

- [ ] **Step 3: Commit**

```bash
git add server/services/google-auth.ts
git commit -m "feat(auth): add verifyGoogleIdToken (lazy google-auth-library)"
```

---

### Task 4: Server endpoint + `handleGoogleLogin` (TDD)

**Files:**
- Create: `server/api/auth/google.post.ts`
- Test: `tests/services/google-auth.test.ts`

`handleGoogleLogin` is pure and takes the verify fn + clientId via `deps` (mirrors `handleForgotPassword(db, body, { mailer, baseUrl })`). The default Nitro handler injects the real `verifyGoogleIdToken`, reads `useRuntimeConfig().public.googleClientId`, and sets the cookie like `login.post.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/google-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedUser } from '../helpers/fixtures'
import { handleGoogleLogin } from '~/server/api/auth/google.post'
import { getSessionUser } from '~/server/services/sessions'
import type { GoogleIdentity } from '~/server/services/google-auth'

const CLIENT_ID = 'test-cid.apps.googleusercontent.com'

// Build a stub verify fn that returns a fixed identity (or null).
function stubVerify(identity: GoogleIdentity | null) {
  return async (_idToken: string, _clientId: string) => identity
}

describe('handleGoogleLogin', () => {
  let db: TestDb
  let close: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; close = t.close })
  afterEach(() => close())

  it('creates a session for a verified email matching an existing user', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'admin@lanka.live', emailVerified: true }), clientId: CLIENT_ID }
    )
    expect(result).not.toBeNull()
    expect(result!.user.email).toBe('admin@lanka.live')
    expect(result!.user.role).toBe('admin')
    expect(await getSessionUser(db, result!.token)).toMatchObject({ email: 'admin@lanka.live' })
  })

  it('matches case-insensitively (token email in mixed case)', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'Admin@Lanka.LIVE', emailVerified: true }), clientId: CLIENT_ID }
    )
    expect(result).not.toBeNull()
    expect(result!.user.email).toBe('admin@lanka.live')
  })

  it('returns null when no user matches the verified email', async () => {
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'ghost@lanka.live', emailVerified: true }), clientId: CLIENT_ID }
    )
    expect(result).toBeNull()
  })

  it('returns null when the email is not verified', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'admin@lanka.live', emailVerified: false }), clientId: CLIENT_ID }
    )
    expect(result).toBeNull()
  })

  it('returns null when token verification fails (verify returns null)', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify(null), clientId: CLIENT_ID }
    )
    expect(result).toBeNull()
  })

  it('returns null when sign-in is disabled (empty clientId)', async () => {
    await seedUser(db, { email: 'admin@lanka.live', role: 'admin' })
    const result = await handleGoogleLogin(
      db,
      { credential: 'jwt' },
      { verify: stubVerify({ email: 'admin@lanka.live', emailVerified: true }), clientId: '' }
    )
    expect(result).toBeNull()
  })

  it('throws a ZodError for a malformed body (no credential)', async () => {
    await expect(
      handleGoogleLogin(db, {}, { verify: stubVerify(null), clientId: CLIENT_ID })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm exec vitest run tests/services/google-auth.test.ts
```
Expected: FAIL — cannot import `handleGoogleLogin` from `~/server/api/auth/google.post` (module/export does not exist yet).

- [ ] **Step 3: Write the endpoint + handler**

Create `server/api/auth/google.post.ts`:

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { createSession, SESSION_COOKIE, type Role, type SessionUser } from '~/server/services/sessions'
import { verifyGoogleIdToken, type GoogleIdentity } from '~/server/services/google-auth'
import { sessionCookieOptions } from '~/server/api/auth/login.post'

const BodySchema = z.object({
  credential: z.string().min(1).max(8192)
})

export type VerifyIdTokenFn = (
  idToken: string,
  clientId: string
) => Promise<GoogleIdentity | null>

/**
 * Verify a Google ID token and, if it maps to an EXISTING user, mint a session.
 * Returns `null` for every non-body failure (disabled, unverified token,
 * unverified email, or no matching user) — the caller maps that to 401.
 * Throws ZodError for a malformed body (caller maps to 400).
 */
export async function handleGoogleLogin(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown,
  deps: { verify: VerifyIdTokenFn; clientId: string }
): Promise<{ user: SessionUser; token: string } | null> {
  const body = BodySchema.parse(rawBody)
  if (!deps.clientId) return null // sign-in disabled (no Client ID configured)

  const identity = await deps.verify(body.credential, deps.clientId)
  if (!identity || !identity.emailVerified) return null

  const email = identity.email.toLowerCase()
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (!u) return null

  const token = await createSession(db, u.id)
  return {
    user: { id: u.id, email: u.email, role: u.role as Role, organizationId: u.organizationId },
    token
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const config = useRuntimeConfig()
  const clientId = (config.public.googleClientId as string) || ''
  let result: { user: SessionUser; token: string } | null
  try {
    result = await handleGoogleLogin(useDb(), body, {
      verify: verifyGoogleIdToken,
      clientId
    })
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  if (!result) {
    throw createError({ statusCode: 401, message: 'No Lanka account for this Google address' })
  }
  setCookie(
    event,
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(process.env.SESSION_COOKIE_SECURE === 'true')
  )
  return { user: result.user }
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm exec vitest run tests/services/google-auth.test.ts
```
Expected: PASS — all 7 tests green. (If import of `google.post.ts` errors on a missing Nitro auto-import, add a `notInTests('<name>')` stub for it in `tests/helpers/nuxt-stubs.ts` and re-run — but `defineEventHandler`, `readBody`, `setCookie`, `useRuntimeConfig`, `useDb`, `createError` are all already stubbed.)

- [ ] **Step 5: Run the full suite (no regressions)**

Run:
```bash
pnpm test
```
Expected: PASS — existing suites unaffected; new file included.

- [ ] **Step 6: Commit**

```bash
git add server/api/auth/google.post.ts tests/services/google-auth.test.ts
git commit -m "feat(auth): POST /api/auth/google — verified-email sign-in for existing users"
```

---

### Task 5: API client method

**Files:**
- Modify: `app/composables/useApiClient.ts:90-93` (interface `// auth` block) and `:214-217` (implementation `// auth` block)

- [ ] **Step 1: Add to the `ApiClient` interface**

In the `// auth` section of the `ApiClient` interface (after the `login` line), add:

```ts
  loginWithGoogle(body: { credential: string }): Promise<{ user: SessionUser }>
```

So the block reads:

```ts
  // auth
  login(body: { email: string; password: string }): Promise<{ user: SessionUser }>
  loginWithGoogle(body: { credential: string }): Promise<{ user: SessionUser }>
  logout(): Promise<void>
  me(): Promise<{ user: SessionUser }>
```

- [ ] **Step 2: Add to the implementation**

In the `// auth` section of `createApiClient` (after the `login:` line), add:

```ts
    loginWithGoogle: (body) => fetch<{ user: SessionUser }>('/api/auth/google', { method: 'POST', body }),
```

So the block reads:

```ts
    // auth
    login: (body) => fetch<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body }),
    loginWithGoogle: (body) => fetch<{ user: SessionUser }>('/api/auth/google', { method: 'POST', body }),
    logout: () => fetch<void>('/api/auth/logout', { method: 'POST' }),
    me: () => fetch<{ user: SessionUser }>('/api/auth/me', { method: 'GET' }),
```

- [ ] **Step 3: Commit**

```bash
git add app/composables/useApiClient.ts
git commit -m "feat(api-client): add loginWithGoogle"
```

---

### Task 6: Auth store action (TDD)

**Files:**
- Modify: `app/stores/auth.ts`
- Test: `tests/stores/auth.test.ts`

- [ ] **Step 1: Write the failing test and update existing `_api` patches**

Edit `tests/stores/auth.test.ts`. First, add `loginWithGoogle` to the three existing `$patch({ _api: ... })` calls so the patched object still satisfies the (now-extended) `_api` type. Change each existing patch from:

```ts
s.$patch({ _api: { me: async () => ({ user: admin }), login: async () => ({ user: admin }), logout: async () => {} } })
```

to:

```ts
s.$patch({ _api: { me: async () => ({ user: admin }), login: async () => ({ user: admin }), loginWithGoogle: async () => ({ user: admin }), logout: async () => {} } })
```

(the `fetchMe` 401 test keeps `me` throwing; only add the `loginWithGoogle` key).

Then append this new test:

```ts
  it('loginWithGoogle stores the returned user', async () => {
    const s = useAuthStore()
    s.$patch({ _api: {
      me: async () => ({ user: admin }),
      login: async () => ({ user: admin }),
      loginWithGoogle: async () => ({ user: admin }),
      logout: async () => {}
    } })
    const u = await s.loginWithGoogle('fake-credential')
    expect(u).toEqual(admin)
    expect(s.role).toBe('admin')
    expect(s.ready).toBe(true)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm exec vitest run tests/stores/auth.test.ts
```
Expected: FAIL — `s.loginWithGoogle is not a function`.

- [ ] **Step 3: Implement the store action + extend the `_api` type**

In `app/stores/auth.ts`, extend the `_api` Pick:

```ts
  _api: Pick<ApiClient, 'login' | 'loginWithGoogle' | 'logout' | 'me'>
```

And add the action after `login` in `actions`:

```ts
    async loginWithGoogle(credential: string): Promise<SessionUser> {
      const { user } = await this._api.loginWithGoogle({ credential })
      this.user = user
      this.ready = true
      return user
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm exec vitest run tests/stores/auth.test.ts
```
Expected: PASS — all auth store tests green.

- [ ] **Step 5: Commit**

```bash
git add app/stores/auth.ts tests/stores/auth.test.ts
git commit -m "feat(auth-store): add loginWithGoogle action"
```

---

### Task 7: Render the Google button on the login page

**Files:**
- Modify: `app/pages/login.vue`

GIS only runs in the browser; SSR is off, so `window`/`document` in `onMounted` is safe. The button renders only when `googleClientId` is configured.

- [ ] **Step 1: Add config + GIS wiring to `<script setup>`**

In `app/pages/login.vue`, replace the script block (lines 1-21) with:

```ts
<script setup lang="ts">
definePageMeta({ layout: false })
const auth = useAuthStore()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

const config = useRuntimeConfig()
const googleClientId = (config.public.googleClientId as string) || ''
const googleBtn = ref<HTMLElement | null>(null)

async function submit() {
  error.value = null
  loading.value = true
  try {
    const user = await auth.login(email.value, password.value)
    await navigateTo(user.role === 'client' ? '/portal' : '/')
  } catch {
    error.value = 'Invalid email or password'
  } finally {
    loading.value = false
  }
}

function loadGisScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as any
    if (w.google?.accounts?.id) return resolve()
    const existing = document.getElementById('gis-client')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('gis load failed')))
      return
    }
    const s = document.createElement('script')
    s.id = 'gis-client'
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('gis load failed'))
    document.head.appendChild(s)
  })
}

async function handleGoogleCredential(response: { credential: string }) {
  error.value = null
  loading.value = true
  try {
    const user = await auth.loginWithGoogle(response.credential)
    await navigateTo(user.role === 'client' ? '/portal' : '/')
  } catch {
    error.value = 'Google sign-in failed, or no Lanka account for that address'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!googleClientId) return
  try {
    await loadGisScript()
    const w = window as any
    w.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential
    })
    w.google.accounts.id.renderButton(googleBtn.value, {
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'signin_with'
    })
  } catch {
    // Script blocked or origin not authorized — button just won't appear.
    // Password login is unaffected.
  }
})
</script>
```

- [ ] **Step 2: Add the divider + button container to the template**

In `app/pages/login.vue`, immediately after the closing `</form>` tag (currently line 135) and before the `<p class="mt-10 ...">` trailing note, insert:

```html
        <template v-if="googleClientId">
          <div class="my-6 flex items-center gap-3 text-xs font-medium text-(--ui-text-dimmed)">
            <span class="h-px flex-1 bg-(--ui-border)" />
            <span>or</span>
            <span class="h-px flex-1 bg-(--ui-border)" />
          </div>
          <div ref="googleBtn" class="flex justify-center" />
        </template>
```

- [ ] **Step 3: Check for NEW type errors only**

⚠️ `pnpm typecheck` is **not a clean gate** in this repo: there are ~381 pre-existing `vue-tsc` errors and `nuxt.config.ts` sets `typeCheck: false` (the project relies on Vitest + `nuxt build`, not `vue-tsc`). Do **not** try to make `pnpm typecheck` pass, and do **not** fix unrelated errors.

Instead confirm this change introduces **no new** errors in the file you touched:
```bash
pnpm typecheck 2>&1 | grep -E "app/pages/login\.vue" || echo "no new errors in login.vue"
```
Expected: `no new errors in login.vue` (the only acceptable output). `useRuntimeConfig`, `ref`, `onMounted`, `navigateTo` are Nuxt auto-imports. The real compile gate is `pnpm build` in Task 9.

- [ ] **Step 4: Manual smoke (dev) — button renders with a Client ID**

Run (use the real dev Client ID, with `localhost:5100` added as an Authorized JS origin in Google Cloud):
```bash
GOOGLE_CLIENT_ID=98326320431-0f7bpo4vlo3uhnj86csdsqndcqii91uv.apps.googleusercontent.com PORT=5100 pnpm dev
```
Then open `http://localhost:5100/login`.
Expected: the email/password form is unchanged; below it, an "or" divider and a Google "Sign in with Google" button appear. Signing in with a Google account whose email matches a seeded user (e.g. set `SEED_*_EMAIL` to your Google address) logs you in and routes to `/` (or `/portal` for a client). A Google account with no matching user shows the "no Lanka account" error and you stay on `/login`.

- [ ] **Step 5: Manual smoke (dev) — no Client ID hides the button**

Run:
```bash
PORT=5100 pnpm dev
```
Open `http://localhost:5100/login`.
Expected: no Google button, no "or" divider; password login works exactly as before.

- [ ] **Step 6: Commit**

```bash
git add app/pages/login.vue
git commit -m "feat(login): render Sign in with Google button when configured"
```

---

### Task 8: Build-time plumbing (Docker) + docs

**Files:**
- Modify: `Dockerfile:11-12` (builder ARG/ENV block)
- Modify: `docker-compose.yml:5-6` (build `args`)
- Modify: `.env.example`
- Modify: `README.md` (env table + deploy step)

- [ ] **Step 1: Add the build ARG to the Dockerfile**

In `Dockerfile`, directly after the existing `MEDIA_PUBLIC_BASE` ARG/ENV lines (11-12), add:

```dockerfile
ARG GOOGLE_CLIENT_ID=""
ENV GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
```

(These must appear **before** the `RUN pnpm build` line so the value is baked into the SPA.)

- [ ] **Step 2: Pass the arg through compose**

In `docker-compose.yml`, under `build.args`, add a second line so it reads:

```yaml
    build:
      context: .
      args:
        MEDIA_PUBLIC_BASE: ${MEDIA_PUBLIC_BASE:-}
        GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
```

- [ ] **Step 3: Document in `.env.example`**

In `.env.example`, after the media/R2 block (around line 28) and before the "Initial accounts" block, add:

```bash
# Google sign-in (optional). Public OAuth Client ID for "Sign in with Google".
# NOT a secret. Plain name (like MEDIA_PUBLIC_BASE): baked into the SPA at build
# time and passed as a Docker build arg. Leave empty → the Google button is
# hidden and password login is unaffected. The OAuth client secret is NOT used.
# Add Authorized JavaScript origins in Google Cloud: http://localhost:5100 (dev)
# and https://app.lanka.live (prod). No redirect URI is needed.
# GOOGLE_CLIENT_ID=000000000000-xxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

- [ ] **Step 4: Document in `README.md`**

In the `## Environment variables` table (after the `MEDIA_PUBLIC_BASE` row, ~line 171), add:

```markdown
| `GOOGLE_CLIENT_ID` | unset | Public Google OAuth Client ID for "Sign in with Google". Baked into the SPA at build time (like `MEDIA_PUBLIC_BASE`). Empty → Google button hidden. No client secret is used. |
```

And in the deploy "Write `/opt/lanka/.env`" step (~line 215), append `GOOGLE_CLIENT_ID` to the list of vars to set (it is consumed at `docker compose up --build` time, like `MEDIA_PUBLIC_BASE`).

- [ ] **Step 5: Verify compose config interpolates the arg**

Run:
```bash
GOOGLE_CLIENT_ID=test-cid.apps.googleusercontent.com docker compose config | grep -A4 "args:"
```
Expected: output shows both `MEDIA_PUBLIC_BASE` and `GOOGLE_CLIENT_ID: test-cid.apps.googleusercontent.com` under `args`. (If `docker` isn't available in this environment, skip and rely on review.)

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example README.md
git commit -m "build+docs: bake GOOGLE_CLIENT_ID into SPA; document Google sign-in setup"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full test suite**

Run:
```bash
pnpm test
```
Expected: PASS — all suites including `tests/services/google-auth.test.ts` and the updated `tests/stores/auth.test.ts`.

- [ ] **Step 2: No NEW type errors from this work**

⚠️ `pnpm typecheck` has ~381 pre-existing errors and `typeCheck: false` is set — it is not a clean gate (see Task 7 Step 3). Confirm none of the files this feature created/changed appear in the typecheck output:
```bash
pnpm typecheck 2>&1 | grep -E "server/services/google-auth\.ts|server/api/auth/google\.post\.ts|app/stores/auth\.ts|app/composables/useApiClient\.ts|app/pages/login\.vue" || echo "no new type errors in feature files"
```
Expected: `no new type errors in feature files`. (Sanity-check the count is unchanged vs. baseline if unsure: `git stash` → count → `git stash pop` → count.)

- [ ] **Step 3: Production build smoke (bake works)**

Run:
```bash
GOOGLE_CLIENT_ID=test-cid.apps.googleusercontent.com pnpm build
```
Expected: build succeeds. Optionally confirm the value was baked:
```bash
grep -rl "test-cid.apps.googleusercontent.com" .output/public >/dev/null && echo "baked into SPA" || echo "NOT baked — investigate"
```
Expected: `baked into SPA`.

- [ ] **Step 4: Confirm clean tree**

Run:
```bash
git status
```
Expected: working tree clean (all changes committed across Tasks 1-8).

---

## Notes for the implementer

- **Operator prerequisites (not code, but sign-in won't work without them):** in Google Cloud, add Authorized JavaScript origins `http://localhost:5100` and `https://app.lanka.live` to the OAuth client, configure the consent screen (prefer **Internal**). The client **secret is unused** — do not put it anywhere.
- **Match-existing-only is load-bearing:** `handleGoogleLogin` returns `null` (→ 401) when no user matches. Never auto-create a user here.
- **Email is lowercased before matching.** Seed/user-management emails are already lowercase.
- **The verifier is the only place `google-auth-library` loads**, and it loads lazily — keep it out of any statically-imported test path.
