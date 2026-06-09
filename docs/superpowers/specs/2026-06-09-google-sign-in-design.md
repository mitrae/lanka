# Lanka — Google Sign-In (Design)

**Date:** 2026-06-09
**Status:** Approved, ready for implementation planning
**Scope:** Add "Sign in with Google" to the dashboard login as an *additional* way to authenticate **already-provisioned** users, alongside the existing email/password form. Uses Google Identity Services (GIS) ID-token flow verified server-side; reuses the existing session machinery unchanged.

## Goal

Let existing Lanka users log into the dashboard by clicking "Sign in with Google" instead of typing a password, while keeping the current provisioning model fully intact (no self-signup, no new accounts created via Google).

## Non-goals (explicitly out of scope)

- **No auto-provisioning.** A Google sign-in for an email with no matching `users` row is rejected (401). Admins still create every account.
- **No account-linking UI**, no "connect/disconnect Google" management, no merging of duplicate accounts.
- **No new identity column** (`google_sub` etc.). Matching is by verified email. (Noted as optional future hardening — deliberately deferred.)
- **No server-side redirect/authorization-code flow**, therefore **no client secret** anywhere in the app.
- **No changes** to the session model, the global Nitro auth middleware, `decideAccess`, roles/org constraints, password login, or password reset.
- **No One Tap / FedCM auto-prompt** — just the explicitly-clicked rendered button.

## Decisions (from brainstorming)

1. **Account model:** match existing users only. Google authenticates a pre-provisioned account matched by email; it never creates one.
2. **Flow:** Google Identity Services (GIS) ID-token. The browser obtains a signed ID-token (JWT) from Google and POSTs it to our server; the server verifies it and mints the normal session.
3. **Credential:** public **Client ID** only (`NUXT_PUBLIC_GOOGLE_CLIENT_ID`). **No client secret** is used or stored — the redirect flow that needs one was not chosen.
4. **Identity matching:** by **verified email** (`email_verified === true` in the token). No schema change.
5. **Coexistence:** password login stays exactly as-is; Google is an added button. If no Client ID is configured, the button does not render and password login is unaffected.
6. **Roles:** applies to whoever already has an account — `super`, `admin`, and `client` alike. The resulting session is identical regardless of how the user authenticated, so all downstream role/org routing (`/` vs `/portal`) is unchanged.

---

## 1. Google Cloud prerequisites (operator setup, not code)

On the existing OAuth 2.0 Client (`98326320431-…apps.googleusercontent.com`):

- **Authorized JavaScript origins:**
  - `http://localhost:5100` — dev (Google permits `http://localhost` origins)
  - `https://app.lanka.live` — production
  - *No Authorized redirect URI is required* — redirect URIs are only for the authorization-code flow, which we are not using.
- **OAuth consent screen** configured. Prefer **Internal** (Workspace-only) so org users sign in with no "unverified app" warning and no test-user list. If **External**, add test users or publish.
- The **client secret is not needed**; if one was generated, delete/rotate it (it must never enter the repo or `.env`).

## 2. Configuration

Add to `runtimeConfig.public` in `nuxt.config.ts`:

```ts
public: {
  mediaPublicBase: process.env.MEDIA_PUBLIC_BASE ?? '',
  googleClientId: process.env.NUXT_PUBLIC_GOOGLE_CLIENT_ID ?? ''
}
```

- Public (client-readable) by design — the Client ID is not a secret.
- Because this is an SPA (`ssr: false`), the value is **baked at build time**. For production it must be present at `pnpm build` (Docker build ARG / build env), mirroring how `MEDIA_PUBLIC_BASE` is handled. Document this in the README deployment notes.
- Dev: set `NUXT_PUBLIC_GOOGLE_CLIENT_ID` in `.env` (gitignored).
- Empty value ⇒ button hidden ⇒ no behavior change.

## 3. Backend — `POST /api/auth/google`

New handler `server/api/auth/google.post.ts`. Already public: `decideAccess`/`isPublicRoute` allow all `/api/auth/*` with no session — **no change to the allowlist needed.**

**Request body:** `{ credential: string }` (the GIS ID-token JWT). Validate with Zod; malformed → 400.

**Verification (security-critical), in a testable service** `server/services/google-auth.ts`:

1. Verify the JWT using the official `google-auth-library` `OAuth2Client.verifyIdToken({ idToken, audience: googleClientId })`. (It fetches + caches Google's certs and checks signature, `iss ∈ {accounts.google.com, https://accounts.google.com}`, `aud === clientId`, and `exp`.) `jose` + Google JWKS is an acceptable lighter alternative; `google-auth-library` chosen for correctness/maintenance.
2. Require `payload.email_verified === true`. Otherwise reject.
3. Extract `payload.email` and **lowercase-normalize** it before matching (emails are case-insensitive; seed/user-management emails are already lowercase).
4. Look up the user: `db.select().from(users).where(eq(users.email, email))`.
   - **No row → 401** `No Lanka account for this Google address`.
   - **Row found →** call the *existing* `createSession(db, user.id)` and return `{ user, token }`, exactly like `authenticateUser`.

**Response & cookie:** identical to `login.post.ts` — `setCookie(event, SESSION_COOKIE, token, sessionCookieOptions(process.env.SESSION_COOKIE_SECURE === 'true'))`, return `{ user }`.

**Error mapping:**

| Condition | Status |
|---|---|
| Missing/invalid body shape | 400 |
| Token fails verification (bad signature/aud/iss/exp) | 401 |
| `email_verified !== true` | 401 |
| No matching user | 401 |

All 401s use a generic-enough message; we don't leak whether an email exists beyond the unavoidable "no account" case (acceptable — this is an internal console).

**Server config access:** read `useRuntimeConfig().public.googleClientId` (or pass it into the service) so the verifier's audience always matches the frontend's Client ID. If unset on the server, the endpoint returns 401 (sign-in disabled) rather than verifying against an empty audience.

## 4. Frontend — `app/pages/login.vue`

- Keep the entire existing email/password form unchanged.
- Below the "Sign in" button, add a divider ("or") and a Google button container.
- Load the GIS script (`https://accounts.google.com/gsi/client`) once on mount — only when `runtimeConfig.public.googleClientId` is non-empty. Use `useHead`/dynamic script injection; guard against double-load.
- Initialize `google.accounts.id.initialize({ client_id, callback })` and `renderButton(el, {...})`. (No `prompt()`/One Tap.)
- Callback receives `response.credential` (JWT) → call a new auth-store action `loginWithGoogle(credential)` → on success `navigateTo(user.role === 'client' ? '/portal' : '/')`; on failure show the same error panel pattern already in the page (e.g. "Google sign-in failed or no account for that address").
- If `googleClientId` is empty, render nothing Google-related.

**Auth store (`app/stores/auth.ts`)**: add `loginWithGoogle(credential: string)` mirroring `login()` — calls a new `_api.loginWithGoogle({ credential })`, sets `this.user`, `this.ready = true`, returns the user. Extend the `_api` Pick type accordingly.

**API client (`app/composables/useApiClient.ts`)**: add `loginWithGoogle({ credential })` → `POST /api/auth/google`.

## 5. Types

- Reuse existing `SessionUser` / `Role` types; the Google endpoint returns the same `{ user }` shape as `/api/auth/login`, so no client type churn beyond the new method signature.

## 6. Testing

Vitest, direct `handle`/service calls per the project's `tests/helpers/nuxt-stubs.ts` convention. Mock the token verifier (inject the verify function or stub `google-auth-library`) so no network is hit:

- Valid token + existing user → session created, `{ user }` returned, cookie semantics asserted via the service return.
- Valid token + **no** matching user → 401.
- Token with `email_verified === false` → 401.
- Token with wrong `aud` (verifier throws) → 401.
- Malformed body (no `credential`) → 400.
- Email normalization: token email in mixed case (e.g. `Super@Lanka.live`) still matches the lowercase-stored `super@lanka.live`.

Add any new Nitro auto-imports used by the handler to `tests/helpers/nuxt-stubs.ts`.

## 7. Dependencies

- Add `google-auth-library` (server-only; small, official). It is **not** loaded on the client. Acceptable per project conventions (cf. `@aws-sdk` is lazy-loaded for R2; this one is server-only and only imported by the auth service).

## 8. Files touched (summary)

| File | Change |
|---|---|
| `nuxt.config.ts` | add `public.googleClientId` |
| `server/services/google-auth.ts` | **new** — verify ID token + match user |
| `server/api/auth/google.post.ts` | **new** — endpoint, sets session cookie |
| `app/pages/login.vue` | render GIS button, call store action |
| `app/stores/auth.ts` | `loginWithGoogle` action + `_api` type |
| `app/composables/useApiClient.ts` | `loginWithGoogle` method |
| `tests/**` | new service/endpoint tests; stub updates |
| `.env.example` / README | document `NUXT_PUBLIC_GOOGLE_CLIENT_ID` + build-time bake + Google Cloud setup |

## 9. Risks & mitigations

- **SPA build-time bake:** a prod build without `NUXT_PUBLIC_GOOGLE_CLIENT_ID` ships a hidden button (silent). Mitigation: README note + the button-hidden fallback is intentional and safe (password login still works).
- **Origin mismatch:** GIS refuses to render if the page origin isn't an Authorized JS origin. Mitigation: documented dev (`localhost:5100`) + prod (`app.lanka.live`) origins in §1.
- **Email-based matching drift:** if a user's Google email differs from their Lanka email, they can't use Google (by design — they fall back to password). Future `google_sub` linking is the escalation path if this becomes painful.
- **Audience confusion:** server verify audience must equal the frontend Client ID. Mitigation: both read the same `googleClientId` config key.
