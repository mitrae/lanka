# Lanka — Hetzner + Cloudflare public deployment design

**Date:** 2026-06-08
**Status:** Approved design — ready for implementation plan
**Supersedes (for this host):** the tailnet-only deployment in
`docs/superpowers/specs/2026-04-18-lanka-deployment-design.md`. That design binds the
app directly to the Tailscale interface. This one keeps the device plane on the
tailnet but exposes the dashboard publicly via Cloudflare Tunnel.

## Goal

Run Lanka on a Hetzner Cloud box (CX-class, Ubuntu 24.04) with:

- The **admin dashboard** reachable at `https://app.lanka.live` from anywhere, no
  Tailscale required for admins.
- The **device control plane** (register / manifest / stream / telemetry) reachable
  **only over the Tailscale tailnet** — unchanged trust model for the TV fleet.
- **Media** (videos/images) served from a **public Cloudflare CDN**
  (`https://media.lanka.live`, backed by R2), straight to the TVs — so the small box
  never proxies video bytes.

Non-goals: multi-host/HA, a marketing site at the apex, Cloudflare Access SSO (noted
as optional hardening), migrating existing tailnet installs.

## Why this shape

The app is one Nuxt monolith (dashboard SPA + `/player` + Nitro API) on a single port.
Three audiences hit it with different trust requirements:

| Audience | Needs | Trust |
|---|---|---|
| Admins | dashboard SPA, `/api/{auth,addresses,groups,devices,playlists,assignments,media,dashboard,portal,organizations}` | public, authenticated by app login |
| TVs (control) | `/player`, `/_nuxt/*`, `POST /api/devices/register`, `GET /api/devices/:id/manifest`, `GET /api/devices/:id/stream`, `POST /api/devices/:id/telemetry` | private (tailnet only) — these are **unauthenticated** by design |
| TVs (media) | the actual video/image bytes | public CDN, content-addressed by sha256 |

The device endpoints are unauthenticated (a TV self-registers), so keeping them off the
public internet prevents fake-device spam, manifest scraping, and SSE-connection abuse.
That isolation is the core security property we preserve.

## Architecture

```
                          ┌──────────── Internet ────────────┐
  Admin browser ──HTTPS──►  Cloudflare edge (TLS, WAF)        │
                          │        │ (named tunnel)           │
                          │        ▼                          │
                          │   cloudflared ──► nginx :8080 ──┐  │  (loopback, plain http)
                          └────────────────────────────────┼──┘
                                                            ▼
  TV (control) ──tailscale0──► nginx 100.x:80 ────────►  app 127.0.0.1:3000  (Nitro, in Docker)
                                                            ▲
  TV (media) ──HTTPS──► Cloudflare CDN ◄── R2 bucket ───────┘ uploads via app (R2Store.put)
                         (media.lanka.live)
```

**Component responsibilities**

- **Nitro app** — binds `127.0.0.1:3000` only (was: the tailnet IP). nginx is its sole
  client. `network_mode: host` stays, so the container's loopback is the host's loopback.
- **nginx (host package)** — the single policy layer, two server blocks:
  - *Public block*, `listen 127.0.0.1:8080;` — what `cloudflared` dials. Returns **403**
    for the device control plane, rate-limits `/api/auth/login`, proxies everything else
    to `127.0.0.1:3000`. No TLS here (edge terminates it).
  - *Tailnet block*, `listen 100.x.x.x:80;` — what the TVs hit. Proxies everything to
    the app (it's fully trusted). Plain http is fine; WireGuard already encrypts it.
- **cloudflared (host systemd service)** — outbound-only named tunnel. Ingress:
  `app.lanka.live → http://localhost:8080`. No inbound ports opened on the box.
- **Cloudflare** — DNS for `lanka.live` (zone moved off GoDaddy), edge TLS + optional WAF,
  the R2 bucket, and the `media.lanka.live` public custom domain on that bucket.
- **R2** — media store. App writes via `R2Store.put` (needs `R2_*` creds). TVs read via
  the public CDN domain. Bucket object key = the sha256, so `media.lanka.live/<sha>`
  resolves directly.

## Traffic flows

1. **Admin login + dashboard** — browser → Cloudflare → tunnel → nginx:8080 → app.
   App sets the `lanka_session` cookie with **`Secure`** (browser sees HTTPS at the edge,
   so `Secure` is honored even though the internal hop is plain http). Auth middleware and
   `decideAccess` are unchanged.
2. **Device control** — TV → `http://100.x/player` → nginx:80 → app. The player registers,
   fetches the manifest, opens the SSE stream, posts telemetry — all over the tailnet.
   These paths return **403** on the public block, so they are unreachable from the internet.
3. **Media playback** — the manifest hands the TV bare sha256s; the player's `fileUrl()`
   shim turns each into `https://media.lanka.live/<sha>`. The TV fetches the bytes from
   Cloudflare's CDN directly — the Hetzner box is never in the media path.
4. **Dashboard thumbnails** — keep going through the app proxy (`/media/:sha/thumb`,
   backed by `R2Store.openThumbnail`). Low volume, admins only; no change needed.

## Security model

- **Inbound public ports on the box: none** (the tunnel is outbound). Only SSH, ideally
  locked to the tailnet (Tailscale SSH) rather than the public NIC.
- **Device plane**: unreachable publicly (nginx 403 + no public port), reachable on the
  tailnet. Optional belt-and-suspenders: a Cloudflare WAF rule that 403s the same paths at
  the edge.
- **Media**: public-but-content-addressed. The 64-hex sha256 is effectively unguessable and
  the manifest that reveals it is tailnet-only. Accepted tradeoff for the CDN offload
  (signage content is not confidential). If that ever changes, revisit with R2 signed URLs
  or a Worker gate — out of scope here.
- **Login**: now internet-facing, so nginx `limit_req` throttles `/api/auth/login`.
- **Defense-in-depth preserved**: the app still never binds a public interface; nginx is the
  only thing that does (and only on loopback for the tunnel + the tailnet IP).

## Required changes

### A. App code (small)

1. **`app/composables/player/usePlayerEnv.ts`** — `fileUrl()` returns the CDN URL when a
   public media base is configured, else the current relative path (dev/local fallback):
   ```ts
   const base = useRuntimeConfig().public.mediaPublicBase // '' in dev
   fileUrl: (sha) => base ? `${base}/${sha}` : `/media/${sha}`
   ```
2. **`nuxt.config.ts`** — add `runtimeConfig.public.mediaPublicBase` from
   `process.env.MEDIA_PUBLIC_BASE ?? ''`. Because the app is an SPA, bake this at **build
   time** via a Docker build ARG (same pattern already used for `appVersion`). The media
   domain is stable, so a rebuild-to-change is acceptable; `deploy.sh` rebuilds anyway.
3. **`server/api/auth/login.post.ts`** — add `secure:` to the `setCookie` options, driven
   by an env flag so plain-http dev still works:
   ```ts
   secure: process.env.SESSION_COOKIE_SECURE === 'true'
   ```

Thumbnails, uploads, the manifest schema, and `R2Store` itself need **no change**. (Verify
during implementation that `R2Store` stores objects under key `<sha>` with no prefix, so the
custom domain serves them at the root path; adjust the public base path if it uses a prefix.)

### B. Deployment artifacts

- **`docker-compose.yml`** — set `HOST=127.0.0.1`. Add prod env (via `.env`): `NODE_ENV`
  (already set), `SESSION_COOKIE_SECURE=true`, `MEDIA_PUBLIC_BASE=https://media.lanka.live`,
  the four `R2_*` vars, and the `SEED_*` passwords. Keep `network_mode: host`.
- **`Dockerfile`** — accept `MEDIA_PUBLIC_BASE` as a build ARG and export it to the env for
  `pnpm build` so it bakes into the client bundle.
- **`ops/nginx/lanka.conf`** *(new)* — the two server blocks above, including:
  - public block: `location = /api/devices/register { return 403; }` and
    `location ~ ^/api/devices/[^/]+/(manifest|stream|telemetry)$ { return 403; }`,
    `limit_req` on `/api/auth/login`, `proxy_buffering off` for `/api/dashboard/stream`.
  - tailnet block: catch-all proxy to the app, `proxy_buffering off` for
    `/api/devices/*/stream`.
  - The tailnet IP is templated once at install (`tailscale ip -4`); it is stable per host.
- **`ops/cloudflared/config.yml`** *(new)* — tunnel credentials + ingress
  (`app.lanka.live → http://localhost:8080`, catch-all `http_status:404`). Run as a host
  systemd service (`cloudflared service install`).
- **`ops/lanka.service`** — drop `ExecStartPre=render-env.sh` (HOST is now static). Keep
  `Requires=tailscaled.service` so the box still won't run the fleet half-connected, and add
  `Wants/After` for nginx + cloudflared ordering as appropriate.
- **`scripts/render-env.sh`** — obsolete for the app (HOST no longer derives from the tailnet
  IP). Either delete it or repurpose it to template the tailnet IP into the nginx config.
- **`scripts/deploy.sh`** — the healthz poll currently sources `HOST`/`PORT` from `.env`;
  point it at `http://127.0.0.1:3000/api/healthz` (or through nginx). Otherwise unchanged.
- **`scripts/backup.sh`** — media now lives in R2 (durability is Cloudflare's); the media
  rsync mirrors only the empty local dir. Keep the DB backup as-is; document that R2 is the
  media source of truth and optionally enable R2 object versioning / an offsite R2 sync.

### C. External setup (Cloudflare + GoDaddy + R2)

1. **Cloudflare zone** — add `lanka.live`, then at **GoDaddy** change the nameservers to the
   two Cloudflare NS records. Wait for activation.
2. **Tunnel** — create a named tunnel (`lanka`), add the `app` DNS route (proxied CNAME to
   `<uuid>.cfargotunnel.com`), install the credentials on the box.
3. **R2** — create bucket `lanka-media`; attach the custom domain `media.lanka.live`
   (Cloudflare provisions the proxied DNS + cert). Create an R2 (S3) API token → endpoint
   `https://<account>.r2.cloudflarestorage.com`, access key id, secret. Set CORS on the
   bucket to allow GET from the player origins if the WebView enforces it.
4. *(optional)* Cloudflare WAF rule mirroring the device-plane 403; Cloudflare Access in
   front of `app.lanka.live` for an extra auth layer.

### D. Hetzner host

- Packages: `docker.io`, `docker-compose-plugin`, `sqlite3`, `rsync`, `curl`, `git`,
  **`nginx`**; Tailscale via the install script; `cloudflared` via the Cloudflare apt repo.
- `tailscale up`; capture the tailnet IP for the nginx tailnet block.
- **Firewall** (Hetzner Cloud Firewall + `ufw`): allow outbound 443 (Cloudflare edge +
  tunnel) and Tailscale (UDP 41641 + DERP over 443); inbound = SSH only, ideally restricted
  to the tailnet. **No inbound 80/443 needed.**

## Deployment runbook (order)

1. Provision the box; install packages; `tailscale up`; lock the firewall.
2. Cloudflare: activate the zone (NS change at GoDaddy), create the tunnel, create the R2
   bucket + `media.lanka.live` custom domain + API token.
3. `git clone` to `/opt/lanka`; write `/opt/lanka/.env` (HOST, NODE_ENV, SESSION_COOKIE_SECURE,
   MEDIA_PUBLIC_BASE, R2_*, SEED_*, TZ).
4. Install nginx config (both blocks) + cloudflared service + the systemd units.
5. Build + start: `docker compose up -d --build` (bakes `MEDIA_PUBLIC_BASE`); start nginx and
   cloudflared.
6. Verify (below). Grab the seeded passwords from the server log if `SEED_*` were left unset.

## Verification checklist

- `https://app.lanka.live/` serves the dashboard; login works; the session cookie has
  `Secure` + `HttpOnly`.
- `https://app.lanka.live/api/devices/register` and
  `https://app.lanka.live/api/devices/<id>/manifest` return **403**.
- From a tailnet device: `http://100.x/api/healthz` is `{ ok: true }`;
  `http://100.x/player?deviceId=...` registers and appears in the dashboard unclaimed tray.
- A claimed TV plays media; the media requests in its network log go to
  `https://media.lanka.live/<sha>` (not the box).
- Dashboard SSE (`/api/dashboard/stream`) stays connected through the tunnel; device SSE
  stays connected over the tailnet.
- `nmap` of the public IP shows no open 80/443; only SSH (or nothing, if SSH is tailnet-only).

## Risks / open questions

- **SPA public runtime config**: baking `MEDIA_PUBLIC_BASE` at build time sidesteps any SPA
  runtime-config ambiguity. If the base must vary without a rebuild later, move the media URL
  into the manifest response instead (server-side, runtime-correct).
- **Tunnel as a dependency**: if the tunnel/cloudflared is down, the dashboard is unreachable
  (the fleet keeps playing — control is tailnet, media is CDN). Acceptable for a prototype.
- **R2 token blast radius**: scope the token to the one bucket.
- **CX disk**: with media on R2, the box only holds the SQLite DB + thumbnails — comfortable.
- **Cloudflare free-plan upload cap (100 MB)**: media files larger than 100 MB cannot be
  uploaded through `app.lanka.live` (Cloudflare returns 413). Workaround: upload large media
  over the tailnet (`http://<tailnet-ip>/media`, which bypasses Cloudflare); the tailnet nginx
  block allows the full 500 MB. Longer term, presigned direct-to-R2 browser uploads remove the
  box and the tunnel from the upload path entirely. Out of scope here.
