# Lanka Deployment (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing Nuxt 4 + Nitro + SQLite monolith as a Docker Compose service on Ubuntu, wrapped by systemd, bound to the Tailscale interface only, with nightly host-side backups, a healthz endpoint, and a self-rollback deploy script.

**Architecture:** Multi-stage `node:22-bookworm-slim` Dockerfile → `.output/` + `node_modules` + `drizzle` kit for migrations. Compose uses `network_mode: host` so Nitro binds to the tailnet IP. systemd wraps `docker compose up`, re-renders `.env` with the current tailnet IP on every start, and also schedules a daily backup timer that runs `sqlite3 .backup` + `rsync` to a sibling directory.

**Tech Stack:** Docker Compose v2, systemd, Bash, Node 22, Nuxt 4, drizzle-kit, better-sqlite3, Tailscale, vitest.

---

## Files to create or modify

**Create (root):**
- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`

**Create (scripts/):**
- `scripts/entrypoint.sh` — container entrypoint (migrate → start Nitro)
- `scripts/render-env.sh` — systemd ExecStartPre; writes `.env` with tailnet IP
- `scripts/backup.sh` — nightly backup (sqlite dump + media rsync)
- `scripts/deploy.sh` — manual upgrade with pre-backup + healthz gate + rollback

**Create (ops/):**
- `ops/lanka.service` — systemd unit wrapping `docker compose up`
- `ops/lanka-backup.service` — oneshot systemd unit for the backup timer
- `ops/lanka-backup.timer` — daily timer for the backup service

**Create (server/):**
- `server/api/healthz.get.ts` — `handleHealthz` pure function + default `defineEventHandler` wrapper

**Create (tests/):**
- `tests/api/healthz.test.ts` — healthy + broken-mediaDir cases
- `tests/api/media-force-delete.test.ts` — atomicity regression test

**Modify:**
- `server/api/media/[id].delete.ts` — wrap DB half of `force=true` in `db.transaction((tx) => {...})`; inline the playlist-version bump inside the transaction (`bumpPlaylistVersion` stays async and unchanged — it's still used by other handlers)
- `.env.example` — append a documented "production (rendered by systemd)" block
- `README.md` — add "Deployment" and "Operations" sections

**Untouched but referenced:**
- `server/db/client.ts` — `useRuntimeConfig()` fragility stays deferred (no caller added in Plan 4)
- `server/services/playlist-version.ts` — `bumpPlaylistVersion` stays as-is

**Note on test layout:** Spec said `tests/integration/healthz.test.ts` and `tests/integration/media-force-delete.test.ts`; project layout puts per-handler tests under `tests/api/` and cross-flow tests under `tests/integration/`. These are per-handler tests, so they go in `tests/api/` for consistency with `tests/api/media-list.test.ts` etc.

---

## Task 1 — Healthz endpoint

**Files:**
- Create: `server/api/healthz.get.ts`
- Test: `tests/api/healthz.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/api/healthz.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { handleHealthz } from '~/server/api/healthz.get'

describe('healthz', () => {
  let db: TestDb
  let close: () => void
  let dir: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-healthz-'))
  })

  afterEach(() => {
    close()
    // Restore writable mode before rm (in case a test flipped it).
    try { chmodSync(dir, 0o755) } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns ok when db responds and mediaDir is writable', async () => {
    const res = await handleHealthz(db, dir)
    expect(res.ok).toBe(true)
    expect(typeof res.version).toBe('string')
  })

  it('throws when mediaDir is not writable', async () => {
    chmodSync(dir, 0o500) // r-x, no write
    await expect(handleHealthz(db, dir)).rejects.toThrow()
  })

  it('throws when mediaDir does not exist', async () => {
    await expect(handleHealthz(db, join(dir, 'does-not-exist'))).rejects.toThrow()
  })
})
```

- [ ] **Step 1.2: Run the test, confirm it fails**

Run: `pnpm test -- tests/api/healthz.test.ts`

Expected: FAIL with a resolution error for `~/server/api/healthz.get` (module not found).

- [ ] **Step 1.3: Create the handler**

Create `server/api/healthz.get.ts`:

```ts
import { sql } from 'drizzle-orm'
import { access, constants } from 'node:fs/promises'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleHealthz(
  db: BetterSQLite3Database<typeof schema>,
  mediaDir: string
): Promise<{ ok: true; version: string }> {
  db.get(sql`SELECT 1`)
  await access(mediaDir, constants.W_OK)
  return { ok: true, version: process.env.npm_package_version ?? 'dev' }
}

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  return handleHealthz(useDb(), config.mediaDir as string)
})
```

- [ ] **Step 1.4: Run the test, confirm it passes**

Run: `pnpm test -- tests/api/healthz.test.ts`

Expected: 3 tests pass.

- [ ] **Step 1.5: Run the full test suite to check no regressions**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add server/api/healthz.get.ts tests/api/healthz.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /api/healthz

Returns 200 iff SQLite responds and MEDIA_DIR is writable.
Used by the Docker HEALTHCHECK and the deploy-script health gate.
EOF
)"
```

---

## Task 2 — Atomicity fix for `handleDeleteMedia force=true`

**Context:** The existing handler deletes `playlist_items`, bumps affected playlist versions, then deletes the `media` row — three separate DB calls. If any call after the first throws (disk full, constraint violation under concurrent writes, unclean container shutdown), state ends up inconsistent. Wrap the DB portion in a synchronous drizzle transaction. File unlinks stay outside the transaction because they're idempotent via `ENOENT` swallowing in `LocalDiskStore`.

**Files:**
- Modify: `server/api/media/[id].delete.ts`
- Test: `tests/api/media-force-delete.test.ts`

- [ ] **Step 2.1: Write the failing atomicity test**

Create `tests/api/media-force-delete.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedMedia, seedPlaylist } from '../helpers/fixtures'
import { LocalDiskStore } from '~/server/services/media-store'
import { handleDeleteMedia } from '~/server/api/media/[id].delete'
import * as schema from '~/server/db/schema'

describe('handleDeleteMedia force=true is atomic', () => {
  let db: TestDb
  let close: () => void
  let dir: string
  let store: LocalDiskStore

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    dir = mkdtempSync(join(tmpdir(), 'lanka-tx-'))
    store = new LocalDiskStore(dir)
  })

  afterEach(() => {
    // Best-effort: drop the trigger if a test installed one and aborted
    // before cleanup.
    try {
      db.run(sql`DROP TRIGGER IF EXISTS media_delete_fail`)
    } catch {}
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rolls back when the media delete fails mid-transaction', async () => {
    const m = await seedMedia(db, { sha256: 'tx', kind: 'image' })
    const pl = await seedPlaylist(db, { items: [{ mediaId: m.id }] })
    expect(pl.version).toBe(1)

    // Force the media DELETE to throw from inside the transaction using a
    // SQLite BEFORE DELETE trigger that RAISE(ABORT, ...)s. This reliably
    // fires whether the handler deletes via db.delete(...) or tx.delete(...),
    // so it's the right tool regardless of implementation detail.
    db.run(sql`
      CREATE TRIGGER media_delete_fail
      BEFORE DELETE ON media
      FOR EACH ROW
      BEGIN SELECT RAISE(ABORT, 'simulated media delete failure'); END
    `)

    await expect(
      handleDeleteMedia(db, store, m.id, { force: true })
    ).rejects.toThrow(/simulated media delete failure/)

    // Drop the trigger so the assertions below can read state freely.
    db.run(sql`DROP TRIGGER IF EXISTS media_delete_fail`)

    // playlist_items must NOT be deleted, and playlist.version must NOT be
    // bumped. If the DB half isn't wrapped in a transaction, both of these
    // run before the failing media delete and persist — the test fails.
    const items = await db
      .select()
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.mediaId, m.id))
    expect(items).toHaveLength(1)

    const [rowPl] = await db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, pl.id))
    expect(rowPl.version).toBe(1)

    const mrows = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, m.id))
    expect(mrows).toHaveLength(1)
  })
})
```

- [ ] **Step 2.2: Run the test, confirm it fails**

Run: `pnpm test -- tests/api/media-force-delete.test.ts`

Expected: FAIL. The existing (pre-fix) code runs the `playlist_items` delete and version bump BEFORE the media delete, as three separate `await`ed statements. The trigger fires on the media delete and throws, but the earlier two statements have already committed. The test's assertions ("playlist_items still there, version still 1") fail.

- [ ] **Step 2.3: Rewrite the DB half of `handleDeleteMedia` as a sync drizzle transaction**

Replace `server/api/media/[id].delete.ts` with:

```ts
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'

export { handleGetMedia } from './[id].get'

export async function handleDeleteMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: number,
  opts: { force: boolean }
): Promise<void> {
  const existing = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, id))
  const row = existing[0]
  if (!row) {
    throw createError({ statusCode: 404, message: `Media ${id} not found` })
  }

  const referencingItems = await db
    .select({ playlistId: schema.playlistItems.playlistId })
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.mediaId, id))

  if (referencingItems.length > 0 && !opts.force) {
    throw createError({
      statusCode: 409,
      message: `Media ${id} is in use by ${referencingItems.length} playlist item(s). Pass force=true to delete anyway.`
    })
  }

  const affectedPlaylists = new Set(referencingItems.map((r) => r.playlistId))

  // DB mutations run in a single transaction. On any throw inside the callback,
  // better-sqlite3 rolls back and re-throws. File unlinks are idempotent
  // (ENOENT is swallowed by LocalDiskStore) and stay outside the transaction.
  db.transaction((tx) => {
    if (opts.force && affectedPlaylists.size > 0) {
      tx.delete(schema.playlistItems)
        .where(eq(schema.playlistItems.mediaId, id))
        .run()
      for (const pid of affectedPlaylists) {
        const bumped = tx
          .update(schema.playlists)
          .set({
            version: sql`${schema.playlists.version} + 1`,
            updatedAt: new Date()
          })
          .where(eq(schema.playlists.id, pid))
          .returning({ id: schema.playlists.id })
          .all()
        if (bumped.length === 0) {
          throw new Error(`Playlist ${pid} not found during force-delete bump`)
        }
      }
    }
    tx.delete(schema.media).where(eq(schema.media.id, id)).run()
  })

  await store.delete(row.sha256)
  await store.deleteThumbnail(row.sha256)
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const q = getQuery(event)
  await handleDeleteMedia(useDb(), useMediaStore(), id, {
    force: q.force === 'true'
  })
  setResponseStatus(event, 204)
  return null
})
```

Changes vs. previous version:
- Imports `sql` from `drizzle-orm` (needed for the inline version-bump expression).
- Drops the `bumpPlaylistVersion` import — the bump is inlined inside the transaction so it can run synchronously. `bumpPlaylistVersion` in `server/services/playlist-version.ts` stays unchanged; other callers still use it.
- DB writes run inside `db.transaction((tx) => {...})`. All operations inside use `.run()` / `.all()` (sync, required by the better-sqlite3 transaction callback which is not async-compatible).
- The select queries and file unlinks stay outside the transaction (reads don't need it; unlinks are idempotent and would be wasteful to include).

- [ ] **Step 2.4: Run the atomicity test, confirm it passes**

Run: `pnpm test -- tests/api/media-force-delete.test.ts`

Expected: PASS.

- [ ] **Step 2.5: Run the existing media tests to check no regressions**

Run: `pnpm test -- tests/api/media-list.test.ts`

Expected: all pre-existing tests still pass (list, get, 404s, 409 unforced, delete non-referenced, force-delete referenced + version bump).

- [ ] **Step 2.6: Run the full suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 2.7: Commit**

```bash
git add server/api/media/\[id\].delete.ts tests/api/media-force-delete.test.ts
git commit -m "$(cat <<'EOF'
fix(media): atomic force-delete

Wrap DB half of force=true in a sync drizzle transaction so a
mid-sequence failure can't leave playlist_items rows deleted and
their playlists un-bumped. Inlines the version bump inside the
transaction callback; bumpPlaylistVersion stays async for other callers.
Idempotent file unlinks stay outside the transaction.
EOF
)"
```

---

## Task 3 — Dockerfile + .dockerignore + entrypoint

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/entrypoint.sh`

- [ ] **Step 3.1: Write `.dockerignore`**

Create `.dockerignore`:

```
node_modules
.nuxt
.output
.git
.idea
.worktrees
data
coverage
tests
docs
.env
.env.local
.env.*.local
*.log
```

Rationale: keeps the build context small (~a few MB vs hundreds), prevents the host's `data/` from accidentally ending up in the image, and excludes tests + docs which don't belong in the runtime image.

- [ ] **Step 3.2: Write `scripts/entrypoint.sh`**

Create `scripts/entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run migrations against the bind-mounted DB, then start Nitro.
# drizzle-kit reads DATABASE_URL from env; compose sets it to
# file:/app/data/signage.db.
pnpm exec drizzle-kit migrate

exec node .output/server/index.mjs
```

Make it executable:

```bash
chmod +x scripts/entrypoint.sh
```

- [ ] **Step 3.3: Write the Dockerfile**

Create `Dockerfile`:

```dockerfile
# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
COPY --from=builder /app/.output       ./.output
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/server/db     ./server/db
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/package.json  ./
COPY scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://'+process.env.HOST+':'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/entrypoint.sh"]
```

Why these choices:
- Debian bookworm (glibc), **not Alpine (musl)** — `@ffmpeg-installer/ffmpeg` and `sharp` ship glibc prebuilts.
- Builder stage has `python3 make g++` so `better-sqlite3` compiles from source against the runtime Node version.
- Runtime stage has `sqlite3` CLI (useful for ad-hoc DB poking via `docker exec`) and `tini` as PID 1 so `SIGTERM` reaches Node cleanly.
- `drizzle.config.ts` + `server/db/` copied into runtime so the entrypoint can run migrations without the full repo.
- Healthcheck uses `$HOST:$PORT` (not `127.0.0.1`): with `network_mode: host` the container shares the host netns, and Nitro binds to the tailnet IP only — loopback wouldn't answer.

- [ ] **Step 3.4: Smoke test the image build**

Run: `docker build -t lanka:test .`

Expected: image builds successfully. Typical duration on a warm cache: 30-90s; cold: 3-10min. The two native-module compiles (`better-sqlite3`, `sharp`) happen in the builder stage.

- [ ] **Step 3.5: Smoke test the image runs**

Create a throwaway data dir and run the container (without systemd, just to confirm the entrypoint works):

```bash
mkdir -p /tmp/lanka-smoke/data/media
docker run --rm \
  -e HOST=127.0.0.1 \
  -e PORT=5101 \
  -e DATABASE_URL=file:/app/data/signage.db \
  -e MEDIA_DIR=/app/data/media \
  -v /tmp/lanka-smoke/data:/app/data \
  --network=host \
  lanka:test &
RUN_PID=$!
sleep 8
curl -fsS http://127.0.0.1:5101/api/healthz && echo
kill $RUN_PID
wait $RUN_PID 2>/dev/null || true
rm -rf /tmp/lanka-smoke
```

Expected: healthz returns `{"ok":true,"version":"..."}`; the server shuts down on kill.

Note: this uses `127.0.0.1` as `HOST` because on the dev box we don't necessarily want to bind to the real tailnet IP. In production `render-env.sh` supplies the real tailnet IP.

- [ ] **Step 3.6: Commit**

```bash
git add Dockerfile .dockerignore scripts/entrypoint.sh
git commit -m "$(cat <<'EOF'
build(docker): multi-stage Dockerfile + entrypoint

Debian bookworm-slim for glibc compatibility with ffmpeg-installer
and sharp prebuilts. Builder compiles better-sqlite3 from source;
runtime stays slim (~250MB). tini as PID 1 for clean SIGTERM.
Entrypoint runs drizzle-kit migrate before starting Nitro.
EOF
)"
```

---

## Task 4 — docker-compose.yml + `.env.example` update

**Files:**
- Create: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 4.1: Write `docker-compose.yml`**

Create `docker-compose.yml`:

```yaml
services:
  lanka:
    build: .
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

Why each field:
- `network_mode: host` — required so Nitro can bind to `tailscale0`. Bridge networking can't see the tailnet interface.
- `env_file: .env` — production values (`HOST` = tailnet IP, `PORT`, `TZ`). The file is rendered by `scripts/render-env.sh` on every systemd start.
- `environment` (inline) — container-internal paths (`DATABASE_URL`, `MEDIA_DIR`) that never vary per host, plus `NODE_ENV=production`.
- `logging` — 10MB × 3 rotation (30MB cap) via Docker's built-in `json-file` driver. No external log dependency.
- `stop_grace_period: 20s` — gives Nitro time to flush SSE + WAL before `SIGKILL`.
- `restart: unless-stopped` — recover from crashes; defer to `systemctl stop` to actually stop.

- [ ] **Step 4.2: Update `.env.example`**

Read the current contents first:

```bash
cat .env.example
```

Expected current contents:

```
DATABASE_URL=file:./data/signage.db
MEDIA_DIR=./data/media
PORT=3000
```

Overwrite with:

```
# Development (pnpm dev) — reads from the repo working dir.
DATABASE_URL=file:./data/signage.db
MEDIA_DIR=./data/media
PORT=3000

# Production (.env on the host; rendered by scripts/render-env.sh
# as part of the lanka.service systemd unit — do not edit by hand
# in production). Only these three values live in .env in prod;
# DATABASE_URL + MEDIA_DIR for the container are hard-set in
# docker-compose.yml because the container paths never vary.
#
# HOST=100.x.y.z        # from `tailscale ip -4`
# PORT=3000
# TZ=Europe/Kyiv
```

- [ ] **Step 4.3: Smoke test `docker compose up` locally**

From the repo root, render a throwaway `.env` and run the service in the background:

```bash
cat > .env <<'EOF'
HOST=127.0.0.1
PORT=5101
TZ=UTC
EOF

docker compose up --build -d

# Poll healthz for up to 30s.
for i in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:5101/api/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS http://127.0.0.1:5101/api/healthz && echo
docker compose ps
docker compose down
rm .env
```

Expected:
- `curl` returns `{"ok":true,"version":"..."}`.
- `docker compose ps` shows the container with `STATUS` including `(healthy)` once the HEALTHCHECK has had time to run (may still say `(health: starting)` in the 15-30s smoke window; that's fine).

IMPORTANT: do NOT commit the `.env` file. It's already in `.gitignore`, but double-check `git status` is clean before the commit below.

- [ ] **Step 4.4: Confirm `.env` is not staged**

Run: `git status`

Expected: `.env` is NOT listed (because `.gitignore` excludes it). Only `docker-compose.yml` and `.env.example` should be untracked/modified.

- [ ] **Step 4.5: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "$(cat <<'EOF'
build(compose): docker-compose.yml for production

network_mode: host so Nitro can bind to the tailnet IP.
env_file supplies HOST/PORT/TZ (host-specific); container paths
are hard-set inline. json-file driver with 10MB*3 rotation.
EOF
)"
```

---

## Task 5 — systemd units + `render-env.sh`

**Files:**
- Create: `scripts/render-env.sh`
- Create: `ops/lanka.service`
- Create: `ops/lanka-backup.service`
- Create: `ops/lanka-backup.timer`

- [ ] **Step 5.1: Write `scripts/render-env.sh`**

Create `scripts/render-env.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Called by systemd ExecStartPre. Reads the current tailnet IP
# and writes /opt/lanka/.env. This runs on every service start
# so a tailnet re-auth or interface change is picked up automatically.

TS_IP="$(tailscale ip -4 | head -n1 || true)"
if [ -z "$TS_IP" ]; then
  echo "render-env.sh: tailscale ip -4 returned empty; refusing to start" >&2
  exit 1
fi

umask 077
cat > /opt/lanka/.env <<EOF
HOST=${TS_IP}
PORT=${LANKA_PORT:-3000}
TZ=${LANKA_TZ:-UTC}
EOF

echo "render-env.sh: wrote /opt/lanka/.env with HOST=${TS_IP}"
```

Make it executable:

```bash
chmod +x scripts/render-env.sh
```

Notes:
- `LANKA_PORT` and `LANKA_TZ` are read from the systemd unit's `Environment=` block (see next step). Defaulting keeps the script runnable standalone for testing.
- `umask 077` + `cat > file` — `.env` is only readable by root. It doesn't hold secrets today but might later.

- [ ] **Step 5.2: Write `ops/lanka.service`**

Create `ops/lanka.service`:

```ini
[Unit]
Description=Lanka digital signage
Documentation=https://github.com/your-org/lanka
Requires=docker.service tailscaled.service
After=docker.service tailscaled.service network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/lanka
Environment=LANKA_PORT=3000
Environment=LANKA_TZ=Europe/Kyiv
ExecStartPre=/opt/lanka/scripts/render-env.sh
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300
Restart=on-failure
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
```

Why:
- `Requires=tailscaled.service` — if Tailscale isn't up, `render-env.sh` fails and the service refuses to start. Defense-in-depth: the service literally cannot come up without a tailnet interface to bind to.
- `Type=simple` + `docker compose up` (foreground, not `-d`) — systemd tracks the compose process so `systemctl stop` really stops it.
- `User=root` — Docker socket access is root-equivalent anyway; no benefit to a dedicated user.
- `Environment=LANKA_PORT=3000` — change here without editing `render-env.sh`.
- `Documentation=` URL is a placeholder; the operator can leave it or point at the actual repo.

- [ ] **Step 5.3: Write the backup service + timer**

Create `ops/lanka-backup.service`:

```ini
[Unit]
Description=Lanka nightly backup
After=lanka.service

[Service]
Type=oneshot
WorkingDirectory=/opt/lanka
ExecStart=/opt/lanka/scripts/backup.sh
User=root
```

Create `ops/lanka-backup.timer`:

```ini
[Unit]
Description=Run Lanka nightly backup daily at 03:00 local time

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
Unit=lanka-backup.service

[Install]
WantedBy=timers.target
```

Why:
- Separate oneshot service + timer — standard systemd pattern for cron-like jobs.
- `Persistent=true` — if the host was off at 03:00, runs at next boot.
- `After=lanka.service` — backup won't run if the main service failed to start (`sqlite3 .backup` against a file the main service never opened still works, but sequencing keeps logs clean).

- [ ] **Step 5.4: Validate unit syntax**

Run the following on the dev box (systemd-analyze is part of systemd and works without installing the units):

```bash
systemd-analyze verify ops/lanka.service ops/lanka-backup.service ops/lanka-backup.timer
```

Expected: no output means success. If there are warnings about `docker.service` / `tailscaled.service` not existing on the dev box (they might not be installed), those are OK — they'd resolve on the target host.

If `systemd-analyze verify` is strict and fails on missing unit names, run with `--recursive-errors=one`:

```bash
systemd-analyze verify --recursive-errors=one ops/lanka.service
```

Alternatively skip this step and rely on the first real install to surface any issues.

- [ ] **Step 5.5: Test `render-env.sh` works standalone**

Run:

```bash
LANKA_PORT=9999 LANKA_TZ=UTC scripts/render-env.sh
cat /opt/lanka/.env 2>/dev/null || cat .env 2>/dev/null
```

Wait — the script hardcodes `/opt/lanka/.env` as the output path. On the dev box that path doesn't exist. Either:

1. Create `/opt/lanka` temporarily and make it writable, OR
2. Use a test override. Change the script to support an override? No — it'd bloat scope.

Simpler: skip this step on the dev box; the first real install on the target host is the validation. Mark the step as deferred-to-deploy rather than blocking plan execution.

- [ ] **Step 5.6: Commit**

```bash
git add scripts/render-env.sh ops/lanka.service ops/lanka-backup.service ops/lanka-backup.timer
git commit -m "$(cat <<'EOF'
feat(ops): systemd units + render-env.sh

lanka.service wraps docker compose up; requires tailscaled so the
service refuses to start without a tailnet IP. render-env.sh
resolves the IP on every start and writes /opt/lanka/.env.
Separate lanka-backup.{service,timer} fires daily at 03:00.
EOF
)"
```

---

## Task 6 — Backup script

**Files:**
- Create: `scripts/backup.sh`

- [ ] **Step 6.1: Write `scripts/backup.sh`**

Create `scripts/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Host-side nightly backup. Safe to run while the container is serving
# writes because signage.db is in WAL mode; sqlite3 .backup uses the
# online backup API.
#
# Layout:
#   /opt/lanka/backups/db/signage-YYYY-MM-DD.db
#   /opt/lanka/backups/media/ (rsync mirror of /opt/lanka/data/media)
#
# Media is mirrored (--delete), not snapshotted: content-addressed
# sha256 filenames never mutate, so a mirror is lossless and cheap.

BACKUP_DIR="${LANKA_BACKUP_DIR:-/opt/lanka/backups}"
DATA_DIR="${LANKA_DATA_DIR:-/opt/lanka/data}"
STAMP="$(date +%F)"
RETENTION_DAYS="${LANKA_RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/media"

echo "backup.sh: sqlite .backup -> $BACKUP_DIR/db/signage-$STAMP.db"
sqlite3 "$DATA_DIR/signage.db" ".backup '$BACKUP_DIR/db/signage-$STAMP.db'"

echo "backup.sh: rsync media -> $BACKUP_DIR/media/"
rsync -a --delete "$DATA_DIR/media/" "$BACKUP_DIR/media/"

echo "backup.sh: pruning db snapshots older than $RETENTION_DAYS days"
find "$BACKUP_DIR/db" -name 'signage-*.db' -mtime +"$RETENTION_DAYS" -delete

if [ -x "$BACKUP_DIR/offsite.sh" ]; then
  echo "backup.sh: invoking offsite hook $BACKUP_DIR/offsite.sh"
  "$BACKUP_DIR/offsite.sh" "$BACKUP_DIR"
else
  echo "backup.sh: no offsite hook; skipping"
fi

echo "backup.sh: done"
```

Make it executable:

```bash
chmod +x scripts/backup.sh
```

Why the env-var overrides:
- `LANKA_BACKUP_DIR` / `LANKA_DATA_DIR` / `LANKA_RETENTION_DAYS` let the script run on the dev box against throwaway paths for validation (next step) without editing the script.

- [ ] **Step 6.2: Smoke test the backup script against a throwaway dataset**

On the dev box:

```bash
# Build a throwaway data dir.
TMPROOT="$(mktemp -d)"
mkdir -p "$TMPROOT/data/media"
sqlite3 "$TMPROOT/data/signage.db" "CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);"
echo "image-bytes" > "$TMPROOT/data/media/abc123"

# Run the script with overrides.
LANKA_BACKUP_DIR="$TMPROOT/backups" \
LANKA_DATA_DIR="$TMPROOT/data" \
LANKA_RETENTION_DAYS=7 \
  scripts/backup.sh

# Verify outputs.
ls "$TMPROOT/backups/db/"
ls "$TMPROOT/backups/media/"
sqlite3 "$TMPROOT/backups/db/signage-$(date +%F).db" "SELECT COUNT(*) FROM t;"

rm -rf "$TMPROOT"
```

Expected:
- `backups/db/signage-YYYY-MM-DD.db` exists.
- `backups/media/abc123` exists.
- `SELECT COUNT(*)` returns `1`.

- [ ] **Step 6.3: Commit**

```bash
git add scripts/backup.sh
git commit -m "$(cat <<'EOF'
feat(ops): nightly backup script

sqlite3 .backup for the DB (online, safe during writes via WAL),
rsync --delete mirror for the content-addressed media store, and
a drop-in offsite.sh hook for future remote copies.
Retention: 7 daily DB snapshots; media is a current-state mirror.
EOF
)"
```

---

## Task 7 — Deploy script

**Files:**
- Create: `scripts/deploy.sh`

- [ ] **Step 7.1: Write `scripts/deploy.sh`**

Create `scripts/deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Manual upgrade flow, run on the host after `ssh lanka-host`.
# 1. Snapshot current DB + media (reuses backup.sh).
# 2. Fast-forward pull from main.
# 3. Rebuild the compose image and restart the service.
# 4. Poll /api/healthz for up to 60s.
# 5. On failure: git reset --hard to the pre-pull HEAD and rebuild.

cd /opt/lanka

echo "==> Pre-upgrade backup"
./scripts/backup.sh

echo "==> Fetching origin"
git fetch --prune
git checkout main

PRE_HEAD="$(git rev-parse HEAD)"
echo "==> Current HEAD before pull: $PRE_HEAD"

echo "==> Pulling (fast-forward only)"
git pull --ff-only

NEW_HEAD="$(git rev-parse HEAD)"
if [ "$PRE_HEAD" = "$NEW_HEAD" ]; then
  echo "==> No new commits; nothing to deploy."
  exit 0
fi

echo "==> Building and restarting"
docker compose up -d --build

echo "==> Resolving HOST/PORT from .env for healthz poll"
HOST_IP="$(grep ^HOST= .env | cut -d= -f2)"
PORT_VAL="$(grep ^PORT= .env | cut -d= -f2)"

echo "==> Waiting for http://${HOST_IP}:${PORT_VAL}/api/healthz"
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://${HOST_IP}:${PORT_VAL}/api/healthz" >/dev/null; then
    echo "==> Healthy after ${i} attempt(s)"
    docker image prune -f >/dev/null || true
    exit 0
  fi
  sleep 2
done

echo "!! Healthz never came up — rolling back to $PRE_HEAD"
git reset --hard "$PRE_HEAD"
docker compose up -d --build

echo "!! Rollback complete. Investigate the failed deploy in docker logs lanka."
exit 1
```

Make it executable:

```bash
chmod +x scripts/deploy.sh
```

Why each step:
- **Pre-upgrade backup is automatic.** The one footgun with "just pull and rebuild" is a bad migration; the snapshot immediately before the build is the mitigation. `backup.sh` is idempotent.
- **No-op short-circuit** — if `git pull` brings nothing new, don't rebuild.
- **`--ff-only`** — refuses if `main` diverged on the host (someone hot-fixed in place). Fail loudly.
- **Health gate** — 60s window to hit `/api/healthz`. Uses `--max-time 3` so a hung connection doesn't eat the whole budget.
- **Rollback by `git reset --hard $PRE_HEAD`** — previous code is captured before the pull so it's not dependent on git reflog. After reset, rebuild so the old version is actually running again.
- **`docker image prune -f`** on success — keeps disk from filling with dangling layers across deploys.

- [ ] **Step 7.2: Partial smoke test on dev box**

We can't fully smoke-test the deploy flow without a real `/opt/lanka` layout. Minimum check: confirm the script is syntactically valid.

```bash
bash -n scripts/deploy.sh
shellcheck scripts/deploy.sh 2>/dev/null || true
```

Expected: no syntax errors. `shellcheck` is optional; warnings are informational.

(A full end-to-end validation happens during the first real install on the target host; see README-Deployment additions in Task 8.)

- [ ] **Step 7.3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "$(cat <<'EOF'
feat(ops): deploy.sh with pre-backup + healthz gate + auto-rollback

Runs backup.sh, fast-forwards main, rebuilds the compose image,
and polls /api/healthz for 60s. On failure, git reset --hard to
pre-pull HEAD and rebuild. No-op short-circuit when main has no
new commits. Uses HOST/PORT from .env for the poll URL.
EOF
)"
```

---

## Task 8 — README: Deployment + Operations sections

**Files:**
- Modify: `README.md`

- [ ] **Step 8.1: Read the current README to find the insertion point**

Run: `cat README.md | tail -20`

Expected: `## Next plans` is near the end, preceded by the Player section. The two new sections go between them.

- [ ] **Step 8.2: Insert the Deployment + Operations sections with one Edit**

Use the Edit tool on `README.md`. Replace this exact string:

```
## Next plans
```

with this exact string (the new sections followed by the unchanged `## Next plans` heading):

````markdown
## Deployment

Production is a single Ubuntu 22.04+ host on a Tailscale tailnet, running the app as one Docker Compose service. All traffic reaches the host over the tailnet; the app binds to the Tailscale interface only, so it's unreachable from the public NIC even if the firewall is misconfigured.

### Host prerequisites

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin sqlite3 rsync curl git
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

### First install

```bash
# Check out the repo under /opt.
sudo git clone <repo-url> /opt/lanka
sudo chown -R root:root /opt/lanka
sudo mkdir -p /opt/lanka/data/media /opt/lanka/backups

# Install systemd units.
sudo cp /opt/lanka/ops/lanka.service        /etc/systemd/system/
sudo cp /opt/lanka/ops/lanka-backup.service /etc/systemd/system/
sudo cp /opt/lanka/ops/lanka-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Start the service and the backup timer.
sudo systemctl enable --now lanka.service
sudo systemctl enable --now lanka-backup.timer
```

Confirm: `systemctl status lanka` shows `active (running)`. Visit `http://<tailnet-ip>:3000` from another tailnet device. `http://<tailnet-ip>:3000/api/healthz` returns `{"ok":true,...}`.

### Upgrading

```bash
ssh <lanka-host>
cd /opt/lanka
sudo ./scripts/deploy.sh
```

The script snapshots the DB + media before the pull, builds and restarts, then polls `/api/healthz` for 60s. On failure it rolls the working tree back to the pre-pull HEAD and rebuilds the previous version.

### Restore from backup

```bash
sudo systemctl stop lanka
sudo cp /opt/lanka/backups/db/signage-YYYY-MM-DD.db /opt/lanka/data/signage.db
sudo rsync -a --delete /opt/lanka/backups/media/ /opt/lanka/data/media/
sudo systemctl start lanka
```

DB snapshots retain 7 days; media is a current-state mirror.

### Offsite backups (optional, future)

Drop an executable at `/opt/lanka/backups/offsite.sh`. `backup.sh` invokes it at the end of each nightly run with the backup root as `$1`. No code change needed.

## Operations

### Logs

- App logs: `docker logs -f lanka` (last 30MB, 3 files × 10MB — configured in `docker-compose.yml`).
- Service lifecycle: `journalctl -u lanka -f`.
- Backup runs: `journalctl -u lanka-backup`.

### Health

- `GET /api/healthz` returns 200 when SQLite responds to `SELECT 1` and `MEDIA_DIR` is writable. The Docker `HEALTHCHECK` polls it every 30s; `docker ps` shows the container as healthy/unhealthy. `restart: unless-stopped` recovers from crashes.

### Backups

- Schedule: nightly at 03:00 local (`lanka-backup.timer`).
- DB snapshot: `/opt/lanka/backups/db/signage-YYYY-MM-DD.db`, 7-day retention.
- Media mirror: `/opt/lanka/backups/media/` (current state, `rsync --delete`).
- Manual run: `sudo systemctl start lanka-backup.service`.
- Next scheduled run: `systemctl list-timers lanka-backup.timer`.

### Common tasks

- Shell into the container: `docker exec -it lanka bash`
- Inspect the DB from the host: `sqlite3 /opt/lanka/data/signage.db`
- Rotate to a new tailnet IP: `sudo systemctl restart lanka` (re-runs `render-env.sh`).

## Next plans
````

- [ ] **Step 8.3: Verify the README renders correctly**

Run: `grep -n '^## ' README.md`

Expected order: `## Lanka`-style top-level sections, followed by `## Deployment`, `## Operations`, `## Next plans`. No duplicate `## Deployment` or `## Operations` headings.

- [ ] **Step 8.4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): deployment + operations sections

Documents host prereqs, first-install steps, upgrade command,
restore procedure, offsite-hook extension point, and the
operator cheat sheet (logs, health, backups, common tasks).
EOF
)"
```

---

## Task 9 — End-to-end verification on dev box

**Goal:** One last smoke test that the pieces work together, without installing on the target host.

- [ ] **Step 9.1: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass, including the two new ones from Tasks 1 and 2.

- [ ] **Step 9.2: Build + run compose locally with a throwaway .env**

```bash
cat > .env <<'EOF'
HOST=127.0.0.1
PORT=5101
TZ=UTC
EOF
docker compose up --build -d

for i in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:5101/api/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

docker compose ps
curl -fsS http://127.0.0.1:5101/api/healthz && echo
docker compose down
rm .env
```

Expected:
- `curl` returns `{"ok":true,"version":"..."}`.
- `docker compose ps` shows the container (`STATUS` may still say `health: starting` in the short smoke window — that's fine as long as curl worked).

- [ ] **Step 9.3: Confirm `.env` is not committed**

Run: `git status`

Expected: no `.env` in the working tree (removed in Step 9.2). Clean tree.

- [ ] **Step 9.4: (Optional) Inspect final image size**

Run: `docker images lanka:latest`

Expected size: 300-500MB. If dramatically larger, check `.dockerignore` and make sure `data/` and `node_modules` aren't in the build context.

- [ ] **Step 9.5: Final commit (if anything drifted)**

If `pnpm install` or the build touched any lockfile artifacts that weren't committed, commit them now. Otherwise skip.

```bash
git status
# If clean, nothing to do. If dirty, review and commit.
```

---

## Out of scope (do NOT do in this plan)

- Android APK work (Plan 5).
- Writing a restore script — restore is documented, not scripted.
- Automatic offsite backups — the hook exists; the destination is a future decision.
- External uptime monitoring.
- `server/db/client.ts` `useRuntimeConfig()` fragility — stays deferred; no caller in Plan 4 triggers it.
- CI/CD, container registry, image tagging.

## Files touched — final checklist

**Created:**
- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- `scripts/entrypoint.sh`
- `scripts/render-env.sh`
- `scripts/backup.sh`
- `scripts/deploy.sh`
- `ops/lanka.service`
- `ops/lanka-backup.service`
- `ops/lanka-backup.timer`
- `server/api/healthz.get.ts`
- `tests/api/healthz.test.ts`
- `tests/api/media-force-delete.test.ts`

**Modified:**
- `server/api/media/[id].delete.ts`
- `.env.example`
- `README.md`
