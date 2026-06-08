# Lanka Hetzner + Cloudflare Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Lanka to a Hetzner box with the dashboard public via Cloudflare Tunnel, the device control plane tailnet-only behind nginx, and media served from a public R2 CDN.

**Architecture:** The Nitro app binds `127.0.0.1:3000`. nginx is the sole front door with two server blocks — a public block on `127.0.0.1:8080` that `cloudflared` dials (403s the device plane, rate-limits login) and a tailnet block on `tailscale0:80` for the TVs. Media uploads still flow through the app into R2; TVs read media bytes straight from `media.lanka.live` (Cloudflare CDN).

**Tech Stack:** Nuxt 4 / Nitro, Docker Compose, nginx, cloudflared, Cloudflare R2 + Tunnel + DNS, Tailscale, systemd, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-08-lanka-hetzner-cloudflare-deployment-design.md`

**Two work categories:**
- **Phases 1–2 (in-repo)** — code + config artifacts an agent implements and verifies here. TDD for code; create-and-verify for config.
- **Phase 3 (operator runbook)** — external, manual steps the human performs on Hetzner/Cloudflare/GoDaddy. Not unit-testable; exact commands + expected output.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `app/composables/player/usePlayerEnv.ts` | modify | `fileUrl()` emits CDN URL when a media base is given |
| `app/composables/player/usePlayerBoot.ts` | modify | pass the configured media base into `usePlayerEnv()` |
| `tests/player/usePlayerEnv.test.ts` | create | unit test for `fileUrl()` |
| `server/api/auth/login.post.ts` | modify | extract `sessionCookieOptions()`, set `secure` from env |
| `tests/api/auth-login.test.ts` | modify | unit test for `sessionCookieOptions()` |
| `nuxt.config.ts` | modify | add `runtimeConfig.public.mediaPublicBase` |
| `Dockerfile` | modify | bake `MEDIA_PUBLIC_BASE` at build time |
| `docker-compose.yml` | modify | `HOST=127.0.0.1`, build arg, prod env passthrough |
| `.env.example` | modify | document the new prod vars |
| `ops/nginx/lanka.conf` | create | the two server blocks |
| `ops/nginx/lanka-proxy.conf` | create | shared proxy header snippet |
| `ops/cloudflared/config.yml` | create | tunnel ingress |
| `ops/lanka.service` | modify | drop `render-env.sh` ExecStartPre |
| `scripts/render-env.sh` | delete | obsolete (HOST is now static) |
| `README.md` | modify | rewrite Deployment section |
| `CLAUDE.md` | modify | update Production deployment summary |

`scripts/deploy.sh` and `scripts/backup.sh` need **no code change** (see Tasks 11–12 notes).

---

## Phase 1 — App code (TDD)

### Task 1: Player emits CDN media URLs

**Files:**
- Modify: `app/composables/player/usePlayerEnv.ts`
- Modify: `app/composables/player/usePlayerBoot.ts:39`
- Test: `tests/player/usePlayerEnv.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/player/usePlayerEnv.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { usePlayerEnv } from '~/app/composables/player/usePlayerEnv'

describe('usePlayerEnv.fileUrl', () => {
  it('returns the relative server path when no media base is set', () => {
    expect(usePlayerEnv().fileUrl('abc123')).toBe('/media/abc123')
  })

  it('returns an absolute CDN url when a media base is set', () => {
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('abc123')).toBe(
      'https://media.lanka.live/abc123'
    )
  })

  it('does not double-slash when sha is appended', () => {
    expect(usePlayerEnv('https://media.lanka.live').fileUrl('zz')).toBe(
      'https://media.lanka.live/zz'
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/player/usePlayerEnv.test.ts`
Expected: FAIL — the second test gets `/media/abc123` because `usePlayerEnv` ignores its argument.

- [ ] **Step 3: Implement the change**

Replace the body of `app/composables/player/usePlayerEnv.ts`'s `usePlayerEnv`:

```ts
export function usePlayerEnv(mediaBase = ''): PlayerEnv {
  return {
    fileUrl(sha256: string): string {
      return mediaBase ? `${mediaBase}/${sha256}` : `/media/${sha256}`
    }
  }
}
```

(Leave the `PlayerEnv` interface and the file's header comment unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/player/usePlayerEnv.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Wire the call site to runtime config**

In `app/composables/player/usePlayerBoot.ts`, change line 39 from:

```ts
  const env = usePlayerEnv()
```

to:

```ts
  const env = usePlayerEnv((useRuntimeConfig().public.mediaPublicBase as string) || '')
```

`useRuntimeConfig` is a Nuxt auto-import available in this composable's setup scope; `mediaPublicBase` is defined in Task 4.

- [ ] **Step 6: Verify the full suite still passes**

Run: `pnpm test`
Expected: PASS (no regressions). `usePlayerBoot` has no unit test, so this only needs to compile.

- [ ] **Step 7: Commit**

```bash
git add app/composables/player/usePlayerEnv.ts app/composables/player/usePlayerBoot.ts tests/player/usePlayerEnv.test.ts
git commit -m "feat(player): serve media from configurable CDN base"
```

---

### Task 2: Session cookie `secure` flag

**Files:**
- Modify: `server/api/auth/login.post.ts`
- Test: `tests/api/auth-login.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/auth-login.test.ts` (and add `sessionCookieOptions` to its imports from `~/server/api/auth/login.post`, and `SESSION_TTL_MS` to its import from `~/server/services/sessions`):

```ts
import { authenticateUser, sessionCookieOptions } from '~/server/api/auth/login.post'
import { getSessionUser, SESSION_TTL_MS } from '~/server/services/sessions'

describe('sessionCookieOptions', () => {
  it('marks the cookie Secure when asked (public HTTPS prod)', () => {
    expect(sessionCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
      secure: true
    })
  })

  it('leaves the cookie insecure for plain-http dev/tailnet', () => {
    expect(sessionCookieOptions(false).secure).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/api/auth-login.test.ts`
Expected: FAIL — `sessionCookieOptions` is not exported.

- [ ] **Step 3: Implement the helper and use it**

In `server/api/auth/login.post.ts`, add the exported helper (after `authenticateUser`):

```ts
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure
  }
}
```

Then replace the `setCookie(...)` call in the default handler with:

```ts
  setCookie(
    event,
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(process.env.SESSION_COOKIE_SECURE === 'true')
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/api/auth-login.test.ts`
Expected: PASS (all auth-login tests + the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add server/api/auth/login.post.ts tests/api/auth-login.test.ts
git commit -m "feat(auth): mark session cookie Secure in production via SESSION_COOKIE_SECURE"
```

---

### Task 3: Public runtime config for the media base

**Files:**
- Modify: `nuxt.config.ts`

- [ ] **Step 1: Add the public config key**

In `nuxt.config.ts`, inside `runtimeConfig`, add a `public` block after the `r2` block:

```ts
    r2: {
      endpoint: process.env.R2_ENDPOINT ?? '',
      bucket: process.env.R2_BUCKET ?? '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? ''
    },
    public: {
      // Public CDN base for media (e.g. https://media.lanka.live). Baked at
      // build time via the Dockerfile ARG because this is an SPA (ssr:false).
      // Empty in dev → the player falls back to the relative /media/<sha> path.
      mediaPublicBase: process.env.MEDIA_PUBLIC_BASE ?? ''
    }
```

- [ ] **Step 2: Verify it builds and types resolve**

Run: `pnpm test`
Expected: PASS. (The `useRuntimeConfig().public.mediaPublicBase` reference from Task 1 now has a backing key.)

- [ ] **Step 3: Commit**

```bash
git add nuxt.config.ts
git commit -m "feat(config): add public.mediaPublicBase runtime config"
```

---

## Phase 2 — Build & runtime config artifacts (create + verify)

### Task 4: Bake `MEDIA_PUBLIC_BASE` into the build

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add the build ARG before `pnpm build`**

In `Dockerfile`, in the `builder` stage, change:

```dockerfile
COPY . .
RUN pnpm build
```

to:

```dockerfile
COPY . .
ARG MEDIA_PUBLIC_BASE=""
ENV MEDIA_PUBLIC_BASE=$MEDIA_PUBLIC_BASE
RUN pnpm build
```

- [ ] **Step 2: Verify the Dockerfile still parses**

Run: `docker build --build-arg MEDIA_PUBLIC_BASE=https://media.lanka.live -f Dockerfile -t lanka:plan-check . 2>&1 | tail -5`
Expected: build completes (or fails only on unrelated host constraints — the ARG line must not error). Then `docker image rm lanka:plan-check`.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: accept MEDIA_PUBLIC_BASE build arg and bake into bundle"
```

---

### Task 5: Compose — loopback bind + prod env

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add the build arg and the env passthroughs**

Edit `docker-compose.yml` so the `lanka` service reads as:

```yaml
services:
  lanka:
    build:
      context: .
      args:
        MEDIA_PUBLIC_BASE: ${MEDIA_PUBLIC_BASE:-}
    container_name: lanka
    restart: unless-stopped
    network_mode: host
    env_file: .env
    environment:
      - NODE_ENV=production
      - DATABASE_URL=file:/app/data/signage.db
      - MEDIA_DIR=/app/data/media
    volumes:
      - ./data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    stop_grace_period: 20s
```

`HOST`, `PORT`, `TZ`, `SESSION_COOKIE_SECURE`, `MEDIA_PUBLIC_BASE`, the four `R2_*`, and the `SEED_*` vars all arrive via `env_file: .env`. Compose also interpolates `${MEDIA_PUBLIC_BASE}` from that same `.env` into `build.args`.

- [ ] **Step 2: Verify compose resolves**

Run: `MEDIA_PUBLIC_BASE=https://media.lanka.live docker compose config >/dev/null && echo OK`
Expected: `OK` (no schema errors).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "build(compose): bind app to loopback, pass media base + R2 env"
```

---

### Task 6: `.env.example` — document prod vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Replace the production block**

In `.env.example`, replace the production comment block (the `# HOST=100.x.y.z ...` section) with:

```bash
# Production (.env on the Hetzner host). The app binds loopback; nginx fronts it.
# HOST=127.0.0.1
# PORT=3000
# TZ=Europe/Kyiv
#
# Session cookie is marked Secure in prod (dashboard is HTTPS via Cloudflare):
# SESSION_COOKIE_SECURE=true
#
# Public CDN base for media (R2 custom domain). Baked at build time AND used to
# interpolate the compose build arg, so set it before `docker compose up --build`:
# MEDIA_PUBLIC_BASE=https://media.lanka.live
#
# R2 is REQUIRED in this deployment (media is served from the public CDN):
# R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
# R2_BUCKET=lanka-media
# R2_ACCESS_KEY_ID=...
# R2_SECRET_ACCESS_KEY=...
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document Hetzner+Cloudflare production vars"
```

---

### Task 7: nginx config

**Files:**
- Create: `ops/nginx/lanka-proxy.conf`
- Create: `ops/nginx/lanka.conf`

- [ ] **Step 1: Create the shared proxy snippet**

Create `ops/nginx/lanka-proxy.conf`:

```nginx
# Shared proxy headers. Included by every proxied location so that nginx's
# per-location proxy_set_header inheritance rules don't drop headers.
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# Edge (Cloudflare) terminates TLS; the app does not branch on this header,
# it is informational. Kept https for the admin-facing public block.
proxy_set_header X-Forwarded-Proto https;
proxy_set_header Connection "";
```

- [ ] **Step 2: Create the server blocks**

Create `ops/nginx/lanka.conf`. Replace `TAILSCALE_IP` with the box's `tailscale ip -4` value at install time (Task 14):

```nginx
# Rate-limit zone for login brute-force (5 requests/min per source IP).
limit_req_zone $binary_remote_addr zone=lanka_login:10m rate=5r/m;

upstream lanka_app { server 127.0.0.1:3000; }

# ---------- PUBLIC block: cloudflared dials this. Plain http on loopback. ----------
server {
    listen 127.0.0.1:8080;
    server_name app.lanka.live;

    # Cloudflare's FREE plan caps proxied request bodies at 100 MB. Uploads
    # larger than that must go via the tailnet block instead (see README).
    client_max_body_size 100m;

    # Device control plane: NEVER served publicly.
    location = /api/devices/register { return 403; }
    location ~ ^/api/devices/[^/]+/(manifest|stream|telemetry)$ { return 403; }

    # Throttle login.
    location = /api/auth/login {
        limit_req zone=lanka_login burst=5 nodelay;
        proxy_pass http://lanka_app;
        include /etc/nginx/snippets/lanka-proxy.conf;
    }

    # Dashboard SSE: stream, don't buffer.
    location = /api/dashboard/stream {
        proxy_pass http://lanka_app;
        include /etc/nginx/snippets/lanka-proxy.conf;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://lanka_app;
        include /etc/nginx/snippets/lanka-proxy.conf;
    }
}

# ---------- TAILNET block: the TVs hit this. Plain http over WireGuard. ----------
server {
    listen TAILSCALE_IP:80;
    server_name _;

    client_max_body_size 600m;  # full media uploads allowed over the tailnet

    # Device SSE stream: stream, don't buffer.
    location ~ ^/api/devices/[^/]+/stream$ {
        proxy_pass http://lanka_app;
        include /etc/nginx/snippets/lanka-proxy.conf;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://lanka_app;
        include /etc/nginx/snippets/lanka-proxy.conf;
    }
}
```

- [ ] **Step 3: Sanity-check the regexes locally**

Run:
```bash
cd /home/dmytro/PhpstormProjects/lanka
node -e 'const re=/^\/api\/devices\/[^/]+\/(manifest|stream|telemetry)$/;
["/api/devices/abc/manifest","/api/devices/abc/stream","/api/devices/abc/telemetry"].forEach(p=>console.assert(re.test(p),"should match "+p));
["/api/devices","/api/devices/abc","/api/devices/abc/reload"].forEach(p=>console.assert(!re.test(p),"should NOT match "+p));
console.log("regex OK")'
```
Expected: `regex OK` (device plane matches; admin device routes — list, `:id`, `reload` — do not).

- [ ] **Step 4: Commit**

```bash
git add ops/nginx/lanka.conf ops/nginx/lanka-proxy.conf
git commit -m "ops(nginx): public + tailnet server blocks, device-plane 403, login rate-limit"
```

---

### Task 8: cloudflared ingress config

**Files:**
- Create: `ops/cloudflared/config.yml`

- [ ] **Step 1: Create the ingress config**

Create `ops/cloudflared/config.yml` (the operator fills `<TUNNEL_UUID>` from Task 15):

```yaml
# Installed to /etc/cloudflared/config.yml on the host.
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: app.lanka.live
    service: http://localhost:8080
  - service: http_status:404
```

- [ ] **Step 2: Commit**

```bash
git add ops/cloudflared/config.yml
git commit -m "ops(cloudflared): tunnel ingress for app.lanka.live -> nginx:8080"
```

---

### Task 9: systemd unit — drop the tailnet render step

**Files:**
- Modify: `ops/lanka.service`
- Delete: `scripts/render-env.sh`

- [ ] **Step 1: Remove the ExecStartPre line**

In `ops/lanka.service`, delete this line:

```
ExecStartPre=/opt/lanka/scripts/render-env.sh
```

Leave `Requires=docker.service tailscaled.service` and the `After=` ordering intact — the box should still refuse to come up without the tailnet (the device plane depends on it), even though the app itself now binds loopback.

- [ ] **Step 2: Delete the obsolete script**

```bash
git rm scripts/render-env.sh
```

(HOST is now the static `127.0.0.1` from `.env`; the tailnet IP is baked into the nginx config once at install, not re-rendered per boot.)

- [ ] **Step 3: Commit**

```bash
git add ops/lanka.service
git commit -m "ops(systemd): drop render-env.sh; app binds static loopback"
```

---

### Task 10: README + CLAUDE.md deployment docs

**Files:**
- Modify: `README.md` (Deployment section)
- Modify: `CLAUDE.md` (Production deployment summary)

- [ ] **Step 1: Rewrite the README Deployment section**

Replace the `## Deployment` section in `README.md` with one describing the hybrid model: app on loopback, nginx public (loopback:8080, device-plane 403, login rate-limit) + tailnet (`tailscale0:80`) blocks, cloudflared tunnel for `app.lanka.live`, media on R2 CDN. Include the operator runbook from Phase 3 and these **Known limitations**:

```markdown
### Known limitations

- **Cloudflare free plan caps uploads at 100 MB.** Media files larger than 100 MB
  cannot be uploaded through `app.lanka.live` (Cloudflare returns 413). Upload large
  media while connected to the tailnet (`http://<tailnet-ip>/media`), which bypasses
  Cloudflare, or implement presigned direct-to-R2 uploads later.
- **The dashboard depends on the tunnel.** If `cloudflared` is down, the dashboard is
  unreachable — but the fleet keeps playing (control is tailnet, media is CDN).
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, update the "Production deployment (summary …)" section: note the deployment now fronts the app with nginx (two server blocks), exposes the dashboard via Cloudflare Tunnel, keeps the device plane tailnet-only, and serves media from the R2 public CDN. Note that `render-env.sh` is gone and the app binds `127.0.0.1`.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: rewrite deployment for Hetzner + Cloudflare hybrid model"
```

---

### Task 11: Verify `deploy.sh` needs no change (read-only check)

- [ ] **Step 1: Confirm the healthz poll resolves with the new HOST**

`scripts/deploy.sh` sources `.env` and polls `http://${HOST}:${PORT}/api/healthz`. With `HOST=127.0.0.1` and `PORT=3000` this is `http://127.0.0.1:3000/api/healthz`, which the container serves on the host network. No change required.

Run (read-only): `grep -n 'HOST\|PORT\|healthz' scripts/deploy.sh`
Expected: confirms the URL is built from `.env` `HOST`/`PORT`. No commit.

---

### Task 12: Verify `backup.sh` needs no change (read-only check)

- [ ] **Step 1: Confirm DB backup still valid; media is R2's job**

`scripts/backup.sh` snapshots the SQLite DB (still on-box) and rsyncs the local media dir (now near-empty since media lives in R2). The DB backup remains correct; the media rsync is a harmless no-op. R2 durability is Cloudflare's. The README "Known limitations"/Backups note documents this. No change required. No commit.

---

## Phase 3 — Operator runbook (manual, on the Hetzner box + Cloudflare/GoDaddy)

> These steps are performed by the human operator. Each lists the exact command and what to expect. Run them in order.

### Task 13: Provision the host

- [ ] Create the CX server (Ubuntu 24.04). SSH in.
- [ ] Install packages:
  ```bash
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-plugin sqlite3 rsync curl git nginx
  ```
  Expected: all install; `docker --version` and `nginx -v` print versions.
- [ ] Install + join Tailscale:
  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  tailscale ip -4
  ```
  Expected: a `100.x.y.z` address. **Record it** — it goes into the nginx tailnet block.
- [ ] Allow nginx to bind the tailnet IP even before tailscaled is fully up at boot:
  ```bash
  echo 'net.ipv4.ip_nonlocal_bind=1' | sudo tee /etc/sysctl.d/99-lanka.conf
  sudo sysctl --system | grep ip_nonlocal_bind
  ```
  Expected: `net.ipv4.ip_nonlocal_bind = 1`.
- [ ] Firewall (Hetzner Cloud Firewall in the console **and** ufw): inbound allow **SSH only**
  (ideally restricted to your tailnet/IP); deny inbound 80/443 — the tunnel is outbound.
  Allow all outbound.
  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow in on tailscale0
  sudo ufw allow 22/tcp        # or skip and use Tailscale SSH only
  sudo ufw enable
  sudo ufw status verbose
  ```
  Expected: incoming denied except SSH + tailscale0.

### Task 14: Deploy the app + nginx

- [ ] Clone and prepare:
  ```bash
  sudo git clone <repo-url> /opt/lanka
  sudo mkdir -p /opt/lanka/data/media /opt/lanka/backups
  cd /opt/lanka && sudo git checkout feat/hetzner-cloudflare-deploy   # or main once merged
  ```
- [ ] Write `/opt/lanka/.env` (mode 600):
  ```bash
  HOST=127.0.0.1
  PORT=3000
  TZ=Europe/Kyiv
  SESSION_COOKIE_SECURE=true
  MEDIA_PUBLIC_BASE=https://media.lanka.live
  R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
  R2_BUCKET=lanka-media
  R2_ACCESS_KEY_ID=<from Task 16>
  R2_SECRET_ACCESS_KEY=<from Task 16>
  SEED_SUPER_PASSWORD=<choose>
  SEED_ADMIN_PASSWORD=<choose>
  SEED_CLIENT_PASSWORD=<choose>
  ```
- [ ] Install nginx config (substitute the recorded tailnet IP):
  ```bash
  sudo cp /opt/lanka/ops/nginx/lanka-proxy.conf /etc/nginx/snippets/lanka-proxy.conf
  sudo sed "s/TAILSCALE_IP/$(tailscale ip -4 | head -n1)/" \
    /opt/lanka/ops/nginx/lanka.conf | sudo tee /etc/nginx/sites-available/lanka.conf >/dev/null
  sudo ln -sf /etc/nginx/sites-available/lanka.conf /etc/nginx/sites-enabled/lanka.conf
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
  ```
  Expected: `nginx: configuration file ... test is successful`.
- [ ] Install systemd unit and start the app:
  ```bash
  sudo cp /opt/lanka/ops/lanka.service /etc/systemd/system/
  sudo cp /opt/lanka/ops/lanka-backup.service /etc/systemd/system/
  sudo cp /opt/lanka/ops/lanka-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now lanka.service lanka-backup.timer
  ```
  Expected: `systemctl status lanka` is `active (running)`.
- [ ] Local healthz:
  ```bash
  curl -fsS http://127.0.0.1:3000/api/healthz
  ```
  Expected: `{"ok":true,...}`.
- [ ] If `SEED_*` were left blank, grab the generated passwords:
  ```bash
  docker logs lanka 2>&1 | grep '\[seed\]'
  ```

### Task 15: Cloudflare zone + tunnel

- [ ] In Cloudflare dashboard: **Add a site** `lanka.live`. Copy the two assigned nameservers.
- [ ] In **GoDaddy**: replace the domain's nameservers with the Cloudflare pair. Wait for
  Cloudflare to show the zone **Active** (minutes–hours).
  ```bash
  dig NS lanka.live +short    # eventually shows the Cloudflare NS
  ```
- [ ] Install cloudflared and create the tunnel:
  ```bash
  # Cloudflare apt repo install per docs, then:
  cloudflared tunnel login          # browser auth, scoped to lanka.live
  cloudflared tunnel create lanka    # prints the TUNNEL_UUID + creds json path
  cloudflared tunnel route dns lanka app.lanka.live
  ```
  Expected: a `<TUNNEL_UUID>` and `/root/.cloudflared/<UUID>.json` (or `/etc/cloudflared/`).
- [ ] Install the ingress config (fill the UUID + creds path) and validate:
  ```bash
  sudo mkdir -p /etc/cloudflared
  sudo cp /root/.cloudflared/<UUID>.json /etc/cloudflared/
  sudo sed "s/<TUNNEL_UUID>/<UUID>/g" /opt/lanka/ops/cloudflared/config.yml \
    | sudo tee /etc/cloudflared/config.yml >/dev/null
  cloudflared tunnel ingress validate
  ```
  Expected: `Validating rules ... OK`.
- [ ] Run cloudflared as a service:
  ```bash
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared
  systemctl status cloudflared
  ```
  Expected: `active (running)`; Cloudflare dashboard shows the tunnel **Healthy**.

### Task 16: R2 bucket + public CDN domain + token

- [ ] Cloudflare **R2 → Create bucket** `lanka-media`.
- [ ] Bucket **Settings → Public access → Connect Custom Domain** → `media.lanka.live`.
  Cloudflare provisions the proxied DNS record + cert. Wait until it shows **Active**.
  ```bash
  # after first upload exists, this should 200:
  curl -I https://media.lanka.live/<some-sha>
  ```
- [ ] **R2 → Manage API tokens → Create** (Object Read & Write, scoped to `lanka-media`).
  Record the **Access Key ID**, **Secret**, and the S3 endpoint
  `https://<account_id>.r2.cloudflarestorage.com`. Put them in `/opt/lanka/.env` (Task 14),
  then `sudo systemctl restart lanka`.
- [ ] (Optional) Set the bucket CORS policy to allow `GET` from the player origins if the
  WebView enforces CORS on media.

### Task 17: End-to-end verification

- [ ] `https://app.lanka.live/` serves the dashboard; login succeeds; in devtools the
  `lanka_session` cookie shows `Secure` + `HttpOnly`.
- [ ] Device plane is shut publicly:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://app.lanka.live/api/devices/register
  curl -s -o /dev/null -w '%{http_code}\n' https://app.lanka.live/api/devices/x/manifest
  ```
  Expected: `403` for both.
- [ ] From a tailnet device:
  ```bash
  curl -fsS http://<tailnet-ip>/api/healthz                       # {"ok":true,...}
  curl -s -o /dev/null -w '%{http_code}\n' http://<tailnet-ip>/api/devices/x/manifest   # 200/204/404, NOT 403
  ```
- [ ] Open `http://<tailnet-ip>/player?deviceId=qa-1` on a tailnet machine → it registers and
  appears in the dashboard unclaimed tray. Claim it, assign a playlist with media.
- [ ] In the player's network panel, media requests go to `https://media.lanka.live/<sha>`
  (Cloudflare), **not** the box.
- [ ] Public port scan shows nothing open:
  ```bash
  nmap -Pn -p 22,80,443 <hetzner-public-ip>
  ```
  Expected: 80/443 filtered/closed; 22 only if you kept public SSH.

---

## Self-review notes

- **Spec coverage:** dashboard-public-via-tunnel (Tasks 8,15), device-plane-tailnet-403 (Task 7), media-R2-CDN (Tasks 1,3,4,16), loopback bind (Task 5), cookie Secure (Task 2), login rate-limit (Task 7), firewall/no-public-ports (Task 13), backups (Task 12), retire render-env (Task 9). All spec sections map to a task.
- **Discovered constraint not in the original spec:** Cloudflare free-plan 100 MB upload cap — surfaced in Task 7 (`client_max_body_size 100m` on the public block, 600m on the tailnet block) and documented in Task 10. The spec's risks should be amended to mention it.
- **Type consistency:** `usePlayerEnv(mediaBase)` (Task 1) ↔ `useRuntimeConfig().public.mediaPublicBase` (Tasks 1,3). `sessionCookieOptions(secure)` defined and consumed in Task 2; tested against `SESSION_TTL_MS`. `MEDIA_PUBLIC_BASE` consistent across Dockerfile (Task 4), compose (Task 5), `.env` (Tasks 6,14).
