# Lanka — Deployment (Plan 4) design

**Status:** Design approved 2026-04-18
**Owner:** Solo dev
**Target:** Single Ubuntu 22.04+ host on a Tailscale tailnet, ≤50 Android TVs

## Summary

Package the existing Nuxt 4 + Nitro + SQLite monolith for reproducible deployment on a single Ubuntu host. One Docker Compose service, wrapped by a systemd unit so the service survives host reboots without a logged-in user. Nightly SQLite online-backup + media rsync to a sibling directory with 7-day retention. Nitro binds to the Tailscale interface only, so the service is physically unreachable from the host's public NIC even if the firewall is misconfigured. Upgrades are manual: `ssh` in, `./scripts/deploy.sh`, which pre-snapshots the DB, pulls, rebuilds, health-gates, and rolls back on failure.

## Goals

- Reproducible production deploy from a fresh Ubuntu box — documented prerequisites, one install command, one upgrade command.
- Durable state: `data/signage.db` and `data/media/` survive container rebuilds, host reboots, and bad deploys.
- Defense-in-depth against accidental public exposure (kernel-level bind to tailnet IP, not just firewall trust).
- Nightly backups that actually run, with a documented restore path.
- Deploy script that's safe to re-run and self-rolls-back on health failure.
- Zero new paid dependencies.

## Non-goals (Plan 4)

- Android APK (Plan 5).
- Multi-host / HA / failover.
- Public internet exposure, TLS termination, or app-level auth (Tailscale owns transit).
- CI/CD, container registries, image tagging.
- External uptime monitoring (tailnet wouldn't let it in).
- Automatic offsite backups (hook in place, destination is a future decision).
- Cloud migration (Heroku, VPS, etc.) — cloud-compat seams preserved per the master spec, no code added for it.

## Constraints carried from master spec

- `ssr: false` (Nuxt SPA). Pinia stores hold `_api: useApiClient()` — serialization would fail under SSR. Deployment does not re-enable SSR.
- better-sqlite3 is a native module; runtime and build-time Node versions must match. Docker makes this trivial.
- Content-addressed media by sha256 → media files never mutate → rsync `--delete` is safe for the media mirror.
- WAL mode already enabled in `server/db/client.ts` — online `.backup` during writes is safe.
- `server/db/client.ts` uses `useRuntimeConfig()` — only safe inside Nitro handlers. Backup script is host-side `sqlite3`, never calls `useDb()`; this stays deferred.

## Host layout

```
/opt/lanka/                      # repo clone, owned by root
├── .env                         # rendered by systemd ExecStartPre (not in git)
├── docker-compose.yml
├── Dockerfile
├── package.json / pnpm-lock.yaml / server/ / app/ / …  (checked-in source)
├── scripts/
│   ├── deploy.sh                # manual upgrade
│   ├── backup.sh                # nightly (timer-driven)
│   ├── render-env.sh            # systemd ExecStartPre
│   └── entrypoint.sh            # container entrypoint (migrate → start)
├── ops/
│   ├── lanka.service            # systemd (installed to /etc/systemd/system/)
│   ├── lanka-backup.service
│   └── lanka-backup.timer
├── data/                        # bind-mounted to container /app/data
│   ├── signage.db (+ -wal, -shm)
│   └── media/
└── backups/                     # sibling of data/, host-local
    ├── db/                      # signage-YYYY-MM-DD.db, 7-day retention
    ├── media/                   # rsync mirror of data/media
    └── offsite.sh               # optional drop-in executable (future)
```

Prereqs on the host: Ubuntu 22.04+, Docker Engine + Compose plugin, Tailscale (`tailscaled` enabled), `sqlite3`, `rsync`, `curl`, `git`. README ships an install checklist.

## Dockerfile

Multi-stage. Debian-based (`node:22-bookworm-slim`), **not Alpine** — `@ffmpeg-installer/ffmpeg` and `sharp` prebuilts are glibc, and Alpine's musl makes both flaky. Trade ~50MB image size for zero native-module surprises.

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

**Why each choice:**

- `tini` as PID 1 — Node doesn't reap zombies or handle signals cleanly as PID 1. `docker compose down` → `SIGTERM` reaches Node → SSE clients close gracefully.
- `sqlite3` + `drizzle.config.ts` + `server/db/` copied into runtime — entrypoint runs `drizzle-kit migrate` against the mounted DB before starting Nitro. Guarantees migrations execute against the version of SQLite shipped in the runtime image.
- Healthcheck hits `$HOST:$PORT/api/healthz` from inside the container. Because `network_mode: host` shares the host netns and Nitro binds to the tailnet IP only (not `0.0.0.0`, not loopback), `127.0.0.1` would not answer — the healthcheck must use the same `HOST` value Nitro bound to. `HOST` is injected into the container via `env_file: .env`.

**`scripts/entrypoint.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm exec drizzle-kit migrate
exec node .output/server/index.mjs
```

## docker-compose.yml

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

**Decisions:**

- `network_mode: host` is required so Nitro can bind to `tailscale0`. Bridge networking can't see the tailnet interface.
- `env_file: .env` contains only host-specific values (tailnet IP, port, TZ). Container-internal paths live in `environment:` because they never vary per host.
- `json-file` with 10MB × 3 = 30MB max log retention. Matches Q6a decision (stdout + json-file, not journald).
- `stop_grace_period: 20s` lets Nitro flush SSE connections and WAL before `SIGKILL`.

## Environment variables

`.env` on the host (written by `render-env.sh`, not in git):

```
HOST=100.x.y.z        # tailnet IP from `tailscale ip -4`
PORT=3000             # reachable only on tailnet because HOST is tailnet-bound
TZ=Europe/Kyiv        # user locale; used for log + backup timestamps
```

`.env.example` gains a block documenting these three. The existing dev-facing block (`DATABASE_URL=file:./data/signage.db` etc.) stays — it's for `pnpm dev` on a workstation, unrelated to production.

## systemd units

**`ops/lanka.service`** — thin wrapper around Compose.

```ini
[Unit]
Description=Lanka digital signage
Requires=docker.service tailscaled.service
After=docker.service tailscaled.service network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/lanka
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

**`scripts/render-env.sh`** (called from `ExecStartPre`):

```bash
#!/usr/bin/env bash
set -euo pipefail
TS_IP="$(tailscale ip -4 | head -n1)"
: "${TS_IP:?tailscale ip -4 returned empty}"
umask 077
cat > /opt/lanka/.env <<EOF
HOST=${TS_IP}
PORT=${PORT:-3000}
TZ=${TZ:-UTC}
EOF
```

**`ops/lanka-backup.service`** (Type=oneshot, `ExecStart=/opt/lanka/scripts/backup.sh`) + **`ops/lanka-backup.timer`** (daily 03:00, `Persistent=true` so a missed run fires at next boot).

**Decisions:**

- `Requires=tailscaled.service` — if Tailscale isn't running, `render-env.sh` fails and the unit refuses to start. Service literally cannot come up without a tailnet interface; defense-in-depth against binding to `0.0.0.0` by accident.
- `Type=simple` + `docker compose up` (foreground, no `-d`) — systemd tracks the real compose process, so `systemctl stop` really stops it.
- `User=root` — Docker socket access is root-equivalent anyway; no benefit to a dedicated user here.
- Upgrade trigger: manual (`scripts/deploy.sh`). No auto-pull timer.

## Healthz endpoint

New file: `server/api/healthz.get.ts`. Split into a pure `handleHealthz` function plus a thin `defineEventHandler` wrapper, matching the existing project convention (CLAUDE.md: "call handleXxx functions directly, not the default export"). Uses drizzle's `sql` template — no existing handler in the codebase reaches into `$client` or `.prepare`.

```ts
import { sql } from 'drizzle-orm'
import { access, constants } from 'node:fs/promises'
import { useDb } from '~/server/db/client'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '~/server/db/schema'

export async function handleHealthz(
  db: BetterSQLite3Database<typeof schema>,
  mediaDir: string
) {
  db.get(sql`SELECT 1`)
  await access(mediaDir, constants.W_OK)
  return { ok: true, version: process.env.npm_package_version ?? 'dev' }
}

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  return handleHealthz(useDb(), config.mediaDir)
})
```

**Why this shape:**

- Returns 200 only if (a) SQLite opens and responds, and (b) `MEDIA_DIR` is writable. Those are the two failure modes `restart: unless-stopped` alone misses — Node can be "up" with a broken DB or a read-only bind-mount, and the device API would 500 silently.
- No auth (same trust model as every other endpoint).
- Handler is <1ms; Docker healthcheck runs every 30s.
- Test coverage: `tests/integration/healthz.test.ts` calls `handleHealthz` directly (bypasses the Nitro wrapper per project convention). Healthy path (temp DB + writable tmp dir) returns `{ok:true,...}`; unwritable `MEDIA_DIR` throws.

## Backup script

`/opt/lanka/scripts/backup.sh`, driven by the systemd timer.

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/opt/lanka/backups
DATA_DIR=/opt/lanka/data
STAMP=$(date +%F)
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/media"

# Online SQLite backup — safe while the app is writing (WAL mode).
sqlite3 "$DATA_DIR/signage.db" ".backup '$BACKUP_DIR/db/signage-$STAMP.db'"

# Media: content-addressed, so rsync --delete is an idempotent mirror.
rsync -a --delete "$DATA_DIR/media/" "$BACKUP_DIR/media/"

# Retention applies only to DB snapshots; media is current-state mirror.
find "$BACKUP_DIR/db" -name 'signage-*.db' -mtime +$RETENTION_DAYS -delete

# Offsite hook — drop-in executable, no code change needed.
if [ -x "$BACKUP_DIR/offsite.sh" ]; then
  "$BACKUP_DIR/offsite.sh" "$BACKUP_DIR"
fi
```

**Decisions:**

- Host-side `sqlite3` uses the online `.backup` API → safe during writes thanks to WAL. App doesn't need to be stopped.
- Media is mirrored, not snapshotted — 50GB × 7 days is wasteful, and content-addressing guarantees files never mutate.
- Only DB snapshots are retention-pruned; the media mirror is always current.
- Offsite hook is a future drop-in (Backblaze B2 / rsync-to-NAS / whatever); no code change in Plan 4.
- Restore is documented in the README, not scripted — `systemctl stop lanka`, `cp backups/db/signage-YYYY-MM-DD.db data/signage.db`, `rsync` media back, `systemctl start lanka`. A restore script is YAGNI until the first real restore.

## Deploy script

`/opt/lanka/scripts/deploy.sh` — manual upgrade, idempotent.

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /opt/lanka

echo "==> Pre-upgrade backup"
./scripts/backup.sh

echo "==> Fetching"
git fetch --prune
git checkout main
git pull --ff-only

echo "==> Building and restarting"
docker compose up -d --build

echo "==> Waiting for healthz"
HOST_IP="$(grep ^HOST= .env | cut -d= -f2)"
PORT_VAL="$(grep ^PORT= .env | cut -d= -f2)"
for i in $(seq 1 30); do
  if curl -fsS "http://${HOST_IP}:${PORT_VAL}/api/healthz" >/dev/null; then
    echo "==> Healthy"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

echo "!! Healthz never came up — rolling back"
git reset --hard HEAD@{1}
docker compose up -d --build
exit 1
```

**Decisions:**

- **Pre-upgrade backup is automatic.** Worst-case upgrade bug is a bad migration; DB snapshot immediately before the build is the cheap mitigation. <5s on prototype-sized data.
- **Health gate + auto-rollback.** 60s window (30 × 2s) to hit `/api/healthz` after the new container starts. On failure, `git reset --hard HEAD@{1}` + rebuild — previous version is one reflog entry away.
- **Forward-only migrations** (Drizzle default). If a migration has corrupted state, the rollback still gets you back on the previous code, but DB fixup is manual from the snapshot. This is an accepted trade for solo-dev simplicity.
- **`--ff-only`** — deploy refuses if `main` diverged on the host (e.g. someone hot-fixed in place). Better to fail loudly.
- **No push-to-deploy from workstation yet.** Adding one later is one line: `ssh lanka-host 'cd /opt/lanka && ./scripts/deploy.sh'`. README mentions this.

## Pre-existing code changes bundled into Plan 4

One tech-debt item flagged in `memory/tech_debt_notes.md` becomes risky under Docker and is in-scope:

- **`handleDeleteMedia force=true` is non-atomic.** Sequence: DELETE playlist_items → bump playlist versions → DELETE media → unlink blob → unlink thumbnail. Any step after the first throwing leaves inconsistent state. Unclean container shutdowns become realistic under Docker, so Plan 4 wraps the DB half in `db.transaction(...)`. File unlinks stay outside the transaction with `ENOENT` swallowing (already idempotent).

Everything else in the tech-debt file stays deferred — not triggered by Plan 4.

## Risks and open soft spots (documented, not fixed here)

1. **`server/db/client.ts` uses `useRuntimeConfig()`.** Safe because the backup script is host-side `sqlite3` and never calls `useDb()`. Plan 5 or later may add a standalone Node script; at that point, switch to reading `process.env.DATABASE_URL` directly (mirrors `drizzle.config.ts`).
2. **Tailnet IP can change.** `render-env.sh` re-reads it on every service start, so reboots and `tailscale up` re-logins pick up the new IP. In-flight connections drop — accepted.
3. **TZ consistency.** `TZ` env var is set in `.env` and passed through compose so backup timestamps (host) and log timestamps (container) match.
4. **Disk-full on `/opt/lanka/data`.** No monitoring in Plan 4. Backup writes will fail loudly via `journalctl -u lanka-backup`. Prereqs doc recommends ≥50GB for data + backups.
5. **No external uptime monitoring.** Tailnet is the boundary; if the host is off the tailnet, nothing else could reach it anyway. Operator checks `/api/healthz` via the dashboard or `systemctl status lanka`.

## Preserved cloud-compat seams (no work, just don't break them)

- `MediaStore` interface — local disk impl today, swappable for S3/R2/MinIO later.
- Drizzle queries stay dialect-agnostic (SQLite → Postgres is a config + regenerate).
- Config via env vars only (12-factor).
- stdout logging — any platform picks it up.
- `.env` separation from compose means pointing at a remote DB/host is one value change.

## README additions

- **Deployment section:** prerequisites, one-time install (clone, `render-env.sh`, `systemctl enable --now lanka lanka-backup.timer`), upgrade command (`./scripts/deploy.sh`), restore procedure.
- **Operations section:** log locations (`docker logs lanka`, `journalctl -u lanka`, `journalctl -u lanka-backup`), healthz URL, how to inspect backup status (`ls -la /opt/lanka/backups/db/`).

## Testing

- **Unit:** none new — the healthz handler's logic is integration-testable.
- **Integration (vitest):** `tests/integration/healthz.test.ts` — hits the handler with a temp DB (expect 200) and with an unwritable `MEDIA_DIR` (expect throw → 500).
- **Integration (vitest):** one test for the `handleDeleteMedia force=true` atomicity fix — mid-transaction throw leaves DB state consistent.
- **Manual:** on a throwaway Ubuntu VM — clone, install, `systemctl start lanka`, confirm dashboard answers on tailnet IP only (not `0.0.0.0`), trigger `scripts/backup.sh`, verify `backups/db/signage-<date>.db` and `backups/media/` populated, run `scripts/deploy.sh` twice (idempotent), simulate a bad deploy by pushing a commit that fails healthz and verify auto-rollback.

## Deliverables

Files added:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`
- `.env.example` (production block appended)
- `scripts/entrypoint.sh`
- `scripts/render-env.sh`
- `scripts/backup.sh`
- `scripts/deploy.sh`
- `ops/lanka.service`
- `ops/lanka-backup.service`
- `ops/lanka-backup.timer`
- `server/api/healthz.get.ts`
- `tests/integration/healthz.test.ts`
- `tests/integration/media-force-delete.test.ts` (atomicity test)
- README additions (Deployment + Operations sections)

Files changed:

- `server/api/media/[id].delete.ts` (wrap DB half of `force=true` in `db.transaction(...)`)
- `README.md`
- `.env.example`
