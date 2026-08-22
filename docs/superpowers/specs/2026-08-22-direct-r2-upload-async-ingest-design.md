# Direct-to-R2 media upload + async ingest — design

**Date:** 2026-08-22 · **Status:** approved (design), spec for implementation plan

## 1. Problem

Dashboard uploads go browser → `app.lanka.live` (Cloudflare-proxied zone) →
`cloudflared` → nginx public block → app → R2. Three limits on that path break
large uploads:

| Hop | Limit | Symptom |
|---|---|---|
| Cloudflare proxy (Free/Pro plan) | **100 MB request body** | `413` from Cloudflare's edge before the box sees anything (verified 2026-08-22 with a 120 MB probe) |
| Cloudflare proxy | 100 s origin response timeout | `524` when the synchronous transcode takes longer |
| nginx `location /` | default `proxy_read_timeout 60s` | `504` on the tailnet block for the same reason |

`media.post.ts` receives the whole file, runs ffmpeg to completion, uploads to
R2 and only then responds — so the HTTP request is held for the entire
transcode. The README's "upload via the tailnet" workaround is broken in prod:
`SESSION_COOKIE_SECURE=true` means the browser drops the session cookie on a
plain-`http://` origin, and the 60 s nginx timeout still applies.

**R2 itself has no such limit:** a single `PutObject` to the R2 S3 endpoint
(`<account>.r2.cloudflarestorage.com`) accepts up to 5 GiB (verified: 120 MB
single PUT → HTTP 200 against the prod bucket). The fix is to put the bytes
there directly and take the transcode out of the request.

## 2. Goals / non-goals

**Goals**
- Upload files well above 100 MB (cap: 2 GiB, configurable) from `app.lanka.live`.
- No HTTP request is held during transcode; no nginx/Cloudflare changes.
- Real upload progress in the dashboard; processing status visible, survives
  closing the dialog and reloading the page.
- Same ingest semantics as today: sha256 content addressing, `(source_sha256,
  quality)` dedup, kiosk-safe transcode, thumbnails, `media` row.
- Works unchanged in local-disk dev/test (no R2).

**Non-goals**
- Multipart/resumable uploads (>5 GiB or flaky links) — single PUT is enough.
- Cancelling a job that is already transcoding.
- Per-user quotas or rate limiting on uploads.
- Pushing status over the dashboard SSE (polling is the baseline; SSE may be
  added later as an accelerator).

## 3. Flow

```
Browser                         app (Nitro)                        R2
  │ POST /api/media/uploads  ──►  insert media_uploads (pending)
  │ {filename,kind,quality,       presign PUT uploads/<id>  ───────►(no request)
  │  mimeType,bytes}         ◄──  {id, upload:{method,url,headers}}
  │
  │ PUT <presigned url> (XHR, progress events) ────────────────────► object
  │                                                                  uploads/<id>
  │ POST /api/media/uploads/:id/complete ──► HEAD uploads/<id> ─────► size check
  │                                          status=queued, enqueue
  │                                   ◄──  {status:'queued'}
  │                                         worker (concurrency 1):
  │                                          GET uploads/<id> ──────► stream
  │                                          ingestMedia() (unchanged):
  │                                            sha256 → dedup → ffmpeg →
  │                                            put media/<sha> ──────► object
  │                                            thumbnail, media row
  │                                          status=done|failed
  │                                          DELETE uploads/<id> ────► gone
  │ GET /api/media/uploads/:id (poll 3 s) ◄─ {status, mediaId, media?, error}
```

With `LocalDiskStore` (dev/tests) the only difference is step 2: `upload.url`
is `PUT /api/media/uploads/:id/file` on the app itself, which streams the raw
body into `<mediaDir>/.uploads/<id>`. The client code path is identical.

## 4. Components

### 4.1 `MediaStore` staging extension (`server/services/media-store.ts`, `r2-store.ts`)

Add to the `MediaStore` interface:

```ts
/** Where a client should send the raw bytes for staged upload `id`. */
createStagedUpload(id: string, opts: { contentType: string; bytes: number }):
  Promise<{ method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: number }>
/** Server-side write path, used by PUT /api/media/uploads/:id/file. */
putStaged(id: string, stream: Readable, contentType: string): Promise<void>
statStaged(id: string): Promise<{ bytes: number } | null>   // null = absent
openStaged(id: string): Promise<Readable>
deleteStaged(id: string): Promise<void>                      // idempotent
```

- **`LocalDiskStore`:** files under `<dir>/.uploads/<id>`; `createStagedUpload`
  returns `{ method: 'PUT', url: '/api/media/uploads/<id>/file', headers:
  { 'content-type': contentType }, expiresAt: now + 1 h }`. `putStaged` reuses
  `putAtomic`.
- **`R2Store`:** key `uploads/<id>`; `createStagedUpload` lazy-imports
  `@aws-sdk/s3-request-presigner` (new dependency, loaded only when R2 is
  configured — same pattern as `client-s3`) and returns
  `getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn: 3600 })`
  with `headers: { 'content-type': contentType }`. `ContentLength` is **not**
  signed (browsers set it themselves); size is verified server-side after
  upload. `putStaged` reuses the existing `upload()` helper; `statStaged` maps a
  404/`NotFound` to `null`; `openStaged`/`deleteStaged` reuse `get`/`del`.
- `id` is validated by callers to be a UUID v4 before reaching the store, so the
  key can never contain path separators.

### 4.2 Schema — `media_uploads` (migration 0012)

```ts
media_uploads
  id            text PK            -- UUID v4 (crypto.randomUUID())
  filename      text not null
  kind          text not null      -- 'video' | 'image'
  quality       text not null      -- 'low' | 'standard' | 'high'
  mime_type     text not null
  bytes         integer not null   -- declared by the client at create time
  status        text not null      -- 'pending' | 'queued' | 'processing' | 'done' | 'failed' | 'expired'
  error         text               -- human-readable, set with failed/expired
  media_id      integer FK media.id on delete set null   -- set on done
  attempts      integer not null default 0
  created_at    integer (ms) not null default unixepoch()*1000
  updated_at    integer (ms) not null default unixepoch()*1000
  index (status), index (created_at)
```

State machine: `pending → queued → processing → done | failed`;
`pending → expired` (sweeper, 24 h) ; `pending → (deleted)` (client cancel);
`processing → queued` (boot recovery, `attempts < 2`) else `→ failed`.

`tests/helpers/test-db.ts` applies real migrations, so tests see the table
automatically once 0012 exists.

### 4.3 API (all under the existing admin/super session gate — `decideAccess`
already 403s `client` for every non-portal `/api/*` route)

| Route | Body / params | Responses |
|---|---|---|
| `POST /api/media/uploads` | `{ filename, kind, quality?, mimeType, bytes }` | `201 { id, status:'pending', upload:{method,url,headers,expiresAt} }` · `400` bad kind/quality, `bytes ≤ 0`, non-integer, or `mimeType` not `video/*`/`image/*` matching `kind` · `413` `bytes > maxUploadBytes` |
| `PUT /api/media/uploads/:id/file` | raw body (`event.node.req` streamed to `store.putStaged`) | `204` · `404` unknown · `409` not `pending` · `400` `content-length` ≠ declared `bytes` · `413` over cap. Handed out only by `LocalDiskStore`, but works for any store. |
| `POST /api/media/uploads/:id/complete` | — | `200 { id, status:'queued' }` · `404` unknown · `409` not `pending` · `400` staged object missing or `statStaged().bytes ≠ bytes` (job → `failed`, staged deleted) |
| `GET /api/media/uploads/:id` | — | `200 { id, filename, kind, quality, bytes, status, error, mediaId, media?: Media, createdAt, updatedAt }` (`media` embedded when `done`) · `404` |
| `GET /api/media/uploads?active=1` | — | `200 UploadJob[]` with status in `pending|queued|processing`, newest first. Without `active=1`: last 50 jobs. |
| `DELETE /api/media/uploads/:id` | — | `204` (deletes staged object + row) · `404` · `409` unless `pending` |

Handlers export `handleXxx(db, store, queue, input)` functions (repo
convention) so tests call them directly; the default export wires Nitro
helpers. `quality` defaults to `standard`; `filename` is trimmed and capped at
255 chars. `maxUploadBytes` comes from `runtimeConfig.maxUploadBytes`
(`MAX_UPLOAD_BYTES`, default `2 * 1024 ** 3`; `entrypoint.sh` bridges it to
`NUXT_MAX_UPLOAD_BYTES` like the other keys).

### 4.4 Ingest service move

`ingestMedia`, `IngestInput`, `IngestedMedia` move verbatim from
`server/api/media.post.ts` to **`server/services/media-ingest.ts`**.
`media.post.ts` keeps the synchronous multipart endpoint (unchanged behaviour,
500 MB formidable cap) importing from the service; the dashboard stops using it
but curl/scripts/tests still can. Existing `tests/api/media-upload*.test.ts`
update their import path only.

### 4.5 Ingest queue + plugin

**`server/services/media-ingest-queue.ts`** — `createIngestQueue({ db, store,
ingest = ingestMedia, log })` returning `{ enqueue(id), drain(): Promise<void>,
recover(): Promise<void>, sweep(now): Promise<void>, size }`.

- **`enqueue(id)`** pushes onto an in-memory FIFO and kicks the loop; the loop
  runs **one job at a time** (2-vCPU box; ffmpeg already uses all cores).
- **Processing a job:** `processing` (+`attempts`) → `ingest(db, store, {
  stream: await store.openStaged(id), filename, kind, mimeType, quality })` →
  `done` + `media_id` → `deleteStaged(id)`. On any throw: `failed` with
  `error = err.message` (the `createError` 422 message "Could not process this
  video" surfaces as-is) → `deleteStaged(id)`. Deletion failures are logged,
  never fatal (the sweeper won't see these rows again, so log loudly).
- **`recover()`** (boot): rows in `processing` → `queued` if `attempts < 2`,
  else `failed` ("interrupted"); then every `queued` row is enqueued (oldest
  first). Rows' staged objects are still in place because deletion happens only
  after a terminal state.
- **`sweep(now)`** (boot + hourly): `pending` rows older than 24 h → delete
  staged object → `expired`.
- **`server/plugins/ingest-worker.ts`** constructs the singleton
  (`useIngestQueue()` in `server/services/ingest-queue-singleton.ts`, same
  shape as `media-store-singleton.ts` with a `_setIngestQueue` test hook), runs
  `recover()` + `sweep()`, and `setInterval(sweep, 1 h).unref()`.
- **Single instance assumption:** one Nitro process owns the queue. Documented
  in CLAUDE.md; no DB-level locking.
- `TRANSCODE_TIMEOUT_MS` in `transcode.ts` goes **10 → 30 min**: nothing holds
  an HTTP connection any more, and `high`/1080p on long clips can exceed 10 min
  on this box.

### 4.6 Dashboard

- **`app/composables/useUploader.ts`** — `uploadFile({ method, url, headers,
  file, onProgress, signal }): Promise<void>` over `XMLHttpRequest`
  (`fetch` has no upload progress). `withCredentials = false` (the R2 PUT is
  cross-origin and must not carry the session cookie; the same-origin local
  `PUT /file` still gets the cookie automatically because it is same-origin —
  XHR sends same-origin cookies regardless of `withCredentials`). Sets exactly
  the returned `headers`. Rejects with `{ status, message }` on non-2xx,
  network error, or abort. A `factory` parameter lets tests inject a fake XHR.
- **`app/types/api.ts`** — `UploadJob`, `UploadTicket` types.
- **`useApiClient`** — `createUpload`, `completeUpload`, `getUpload`,
  `listActiveUploads`, `cancelUpload`.
- **`app/stores/media.ts`** — new state `uploads: UploadJob[]` (active jobs) +
  `startUpload(file, quality, onProgress, signal)` which runs create → PUT →
  complete and returns the job; `pollUploads()` seeds `uploads` from
  `?active=1` once, then — on a single 3 s timer that runs only while `uploads`
  is non-empty — calls `GET /:id` for every tracked job (per-job reads are
  needed to observe the terminal `done`/`failed` state, which `?active=1` no
  longer lists). `done` → `refresh()` the media list and drop the job; `failed`
  → move it to `failedUploads` for the page to toast once, then drop.
  `upload(form)` (legacy) is removed from the store.
- **`MediaUploadDialog.vue`** — files upload **sequentially**; each list row
  gets a `UProgress` (0–100 %) and state text (uploading / queued / failed).
  "Upload" becomes disabled while in flight; "Cancel" aborts the current XHR
  and `DELETE`s its pending job. When the last file is `queued` the dialog
  closes and emits `uploaded`. Errors per file are toasted (as today).
- **`app/pages/media.vue`** — renders `store.uploads` as **placeholder cards**
  (`MediaProcessingCard.vue`: icon, filename, size, status label, spinner)
  before the real `MediaCard`s; calls `store.pollUploads()` on mount. Toasts
  `failedUploads` as they appear.
- **i18n** — add to `en.json` and `uk.json`: uploading / queued / processing /
  failed labels, cancel, "Max {n} GB per file" (replace the "Max 500 MB" copy),
  processing-card strings.

### 4.7 Config & ops

- `runtimeConfig.maxUploadBytes` (+ `.env.example`, `entrypoint.sh` bridge).
- `package.json`: `@aws-sdk/s3-request-presigner` (runtime dep).
- **R2 CORS rule (one-off, prod):** `scripts/r2-cors.ts` (run with
  `pnpm tsx scripts/r2-cors.ts`, reads `R2_*` + `APP_BASE_URL` from env) sends
  `PutBucketCors` with:
  ```json
  [{ "AllowedOrigins": ["https://app.lanka.live"],
     "AllowedMethods": ["PUT"],
     "AllowedHeaders": ["content-type"],
     "MaxAgeSeconds": 3600 }]
  ```
  The same JSON is documented in the README for the Cloudflare dashboard
  (R2 → bucket → Settings → CORS policy). Dev on local disk needs no CORS.
- README: replace the "Cloudflare free plan caps uploads at 100 MB" limitation
  with the new flow + the CORS step; CLAUDE.md gets a short "uploads" gotcha
  (presigned URL targets the S3 endpoint, never `media.lanka.live`; single
  worker; staged objects are deleted after ingest).
- **No nginx changes.** The `/api/media/uploads/*` routes are session-gated
  dashboard routes and ride the existing public block.

## 5. Error handling

| Failure | Behaviour |
|---|---|
| Presigned PUT rejected by R2 (CORS missing, expired URL) or network error | XHR rejects → per-file toast with status; the dialog then `DELETE`s the job it created (best effort). If that also fails the job stays `pending` and the sweeper expires it after 24 h |
| Browser closed mid-upload | job `pending`, partial object never materialises in R2 (S3 PUT is atomic); sweeper expires after 24 h |
| `complete` with size mismatch / missing object | `400`, job `failed`, staged deleted |
| ffmpeg fails / times out | job `failed` with message; staged deleted; toast on the media page |
| Dedup hit (same `source_sha256` + `quality`) | `ingestMedia` returns the existing row → job `done` with that `mediaId` (same as today) |
| Server restart mid-transcode | `recover()` re-queues once (`attempts < 2`); second interruption → `failed` |
| Disk full in container `/tmp` | ingest throws → `failed`; tmp dir removed in `finally` (existing behaviour) |

## 6. Security

- All routes require an admin/super session (existing middleware).
- A presigned URL is scoped to one key, `PUT` only, bound to the declared
  `content-type`, 1 h expiry. It is returned only to the authenticated creator
  and never logged.
- Staged objects live in the public bucket under `uploads/<uuid-v4>`
  (122 bits of entropy), are deleted on any terminal state, and expire after
  24 h. A private second bucket is deliberately not introduced.
- `mimeType`/`kind` from the client are hints only: video goes through
  ffprobe/ffmpeg regardless; images keep today's behaviour.
- Size is enforced twice: `bytes ≤ maxUploadBytes` at create, and the actual
  object size must equal the declared `bytes` at `complete`.
- The local `PUT /file` handler enforces `content-length` == declared bytes and
  aborts the stream past the cap.

## 7. Testing

- **`tests/services/media-ingest-queue.test.ts`** — FIFO + concurrency 1;
  done path (row updated, `media_id` set, staged deleted); failed path (error
  stored, staged deleted); `recover()` re-queues `processing`/`queued` and
  fails after 2 attempts; `sweep()` expires only `pending` > 24 h. Uses
  `createTestDb()` + `LocalDiskStore` + an injected fake `ingest`.
- **`tests/api/media-uploads.test.ts`** — the five handlers: validation
  (kind/quality/mime/bytes/cap), ticket shape from `LocalDiskStore`, local
  `PUT /file` size checks, `complete` transitions (`pending→queued`, `409` on
  re-complete, `400` mismatch → `failed`), `GET` embeds `media` when done,
  `?active=1` filter, `DELETE` only when `pending`.
- **`tests/services/r2-store.test.ts`** — extend: `createStagedUpload` calls the
  presigner with `Bucket/Key=uploads/<id>/ContentType` and `expiresIn: 3600`
  (mock `@aws-sdk/s3-request-presigner`); `statStaged` maps 404 → `null`.
- **`tests/services/media-store.test.ts`** — extend: local staging round-trip.
- **`tests/composables/useUploader.test.ts`** — fake XHR: progress events,
  2xx resolve, 4xx reject, abort.
- **`tests/stores/media.test.ts`** (new, following `tests/stores/*.test.ts`) —
  `startUpload` sequence and `pollUploads` transitions with a mocked `_api`.
- Existing `media-upload*.test.ts` keep passing after the import move.
- **Manual gate:** `pnpm build` + `node .output/server/index.mjs` locally
  (local disk path), then on prod: run `scripts/r2-cors.ts`, upload a
  >100 MB video from `app.lanka.live`, watch it go queued → processing → done,
  confirm `uploads/<id>` is gone from the bucket and the media plays.

## 8. Rollout

1. Merge + deploy (`deploy.sh`; migration 0012 is additive).
2. Run the CORS script once against the prod bucket (or paste the JSON in the
   Cloudflare dashboard).
3. Verify with a >100 MB upload.
4. Rollback: the previous image ignores `media_uploads`; staged objects (if
   any) are orphaned under `uploads/` and can be deleted by hand.

## 9. Later (not in this spec)

- Push job status over the existing dashboard SSE to replace polling.
- Multipart presigned uploads for >5 GiB / resumable uploads.
- Cancel while `processing` (kill ffmpeg).
- Per-org attribution of uploads (`media.organization_id` is set separately today).
