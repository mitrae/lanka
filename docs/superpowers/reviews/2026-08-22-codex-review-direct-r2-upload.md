# Codex review — direct-to-R2 upload + async ingest (2026-08-22)

Reviewer: OpenAI Codex (`codex exec`, read-only) on spec `73e8c2a` + plan `627c0d1`. Triage and round 2 by Claude. Outcome folded into the spec/plan in the following commit.

## Round 1 — findings

## Critical

- **Task 5 — queue worker: transient failures permanently destroy uploads.**  
  `catch (...) { status: 'failed' } finally { await store.deleteStaged(id) }` treats R2 GET failures, database errors, disk-full conditions, and process-level resource failures exactly like invalid media. A brief R2 outage loses the only staged copy and forces a full re-upload. Change the state machine to distinguish retryable infrastructure failures from permanent ingest failures, retain the staged object while retrying with bounded backoff, and delete only after `done` or a confirmed permanent failure.

- **Tasks 5/7 — completion, cancellation, and worker claiming are not atomic.**  
  `handleCompleteUpload` reads `pending`, then later runs an unconditional update; cancellation similarly reads then deletes. Concurrent `complete`/`DELETE` requests can both pass validation. One can delete the row/object while the other gets `returning()` with no row and still calls `queue.enqueue(id)`. Two concurrent completes can enqueue twice. Use conditional writes such as `UPDATE ... WHERE id=? AND status='pending' RETURNING ...`; require exactly one returned row. Cancellation should conditionally delete/transition first, then clean storage. Worker claiming should likewise atomically change `queued → processing`.

- **Task 5 — a second Nitro process can process and delete the same staged object.**  
  The plan documents a single-instance assumption, but the database does not enforce ownership. Any accidental second container during deployment or recovery can select the same queued row; both workers then ingest it and one can delete the staged object underneath the other. Add an atomic claim token/lease even if production normally runs one instance.

- **Tasks 2/5 — restart mid-transcode leaks large `/tmp` files.**  
  `finally { rm(tmpDir) }` cannot run after SIGKILL, host reboot, or container replacement. With uploads up to 2 GiB, abandoned `lanka-ingest-*` and thumbnail directories can exhaust the approximately 11 GiB free disk after a few restarts. Add boot cleanup of owned, sufficiently old temp directories and place ingest scratch space in an explicitly monitored/capped location.

## Important

- **Task 9 — failure of `/complete` leaves an uploaded object stranded as `pending`.**  
  `startUpload()` cancels only when the PUT throws:
  ```ts
  const job = await this._api.completeUpload(created.id)
  ```
  If the PUT succeeds and the complete response is lost, the store reports failure, never tracks the job, and does not retry or reconcile it. The server may already have queued it, or it may remain pending for 24 hours. Make completion idempotent, return the current queued/processing/done job on repeat, and retry/reconcile `GET` before deciding whether cancellation is safe.

- **Task 6 — presigning failure leaves an unusable database row.**  
  The code inserts `media_uploads` before `store.createStagedUpload()`. An SDK/configuration failure leaves a `pending` row with no ticket. Presign before insertion where possible, or delete/mark failed in a catch block.

- **Task 7 — local upload checks only an upper bound, not exact bytes.**  
  The limiter rejects `seen > declared`, but never rejects `seen < declared`. A prematurely ended stream can return 204 with a short staged file; only `/complete` notices later. Count through flush/end, require `seen === declared`, and remove the staged file on every receive failure.

- **Task 7 — local PUT can overwrite an existing pending staged file.**  
  The same ticket can be replayed while the row remains pending. Concurrent PUTs race through `putAtomic`, with last rename winning. Add a one-time upload nonce/version or reject if a staged object already exists; serialize writes per job.

- **Tasks 4/7 — presigned PUT has a completion-time TOCTOU window.**  
  The server HEADs the object and then the worker opens it, but the URL remains valid for an hour. Anyone holding the ticket can overwrite the same key after validation, including during processing. Make the completed object immutable by copying/moving it to a new server-controlled key, revoke via a per-attempt key, or verify size/hash from the exact downloaded stream and retain strong job ownership semantics.

- **Task 12 / security — public staging cleanup has no storage-level guarantee.**  
  The spec says staged objects “expire after 24 h,” but only the running application sweeper deletes them. App downtime, lost database rows, deletion failures, and rollback leave public objects indefinitely. Configure an R2 lifecycle rule for `uploads/` as a hard backstop and document its verification.

- **Security — public staged objects provide secrecy, not access control.**  
  `uploads/<uuid-v4>` is impractical to guess, but any leaked object URL is anonymously readable through the public bucket/custom domain, potentially cached after deletion. This is unsuitable for confidential material. Exclude `uploads/` from the public custom domain if possible, use a private staging bucket, or explicitly state that uploaded source material is non-confidential.

- **Security — image uploads are not validated as images.**  
  The plan calls `mimeType` a hint, but image ingest stores bytes unchanged with the client-selected content type. An authenticated admin can publish arbitrary bytes, SVG active content, or HTML-like payloads through the public media domain. Decode/re-encode supported raster formats and reject everything else; at minimum prohibit SVG and verify magic bytes.

- **Tasks 5/7 — no retry/reconciliation after enqueue loss.**  
  The database is set to `queued` before an in-memory `enqueue()`. A process exit in between leaves the job queued until the next restart; the hourly task only sweeps pending rows. Run queued-job recovery periodically, or have the worker poll/claim queued rows from SQLite instead of relying on an in-memory notification.

- **Task 5 — boot recovery errors are swallowed permanently.**  
  The plugin logs `boot recovery failed` and continues with only hourly `sweep()`. Existing queued jobs then remain stuck until another restart. Retry recovery periodically and expose worker health/backlog in health checks or logs.

- **Operational capacity — the 2 GiB cap is unsafe relative to available disk.**  
  During video ingest there may be the downloaded input, encoded output, thumbnail scratch copy, plus storage/backend buffers. Local-disk mode additionally retains the staged source. A single job can consume several GiB; multiple pending local uploads can consume all 11 GiB. Enforce preflight free-space headroom, cap local staging separately, and document worst-case space requirements.

- **Operational capacity — memory exposure is not tested.**  
  Thumbnail generation receives a fresh stream of the potentially multi-GiB file, and image processing behavior is not covered by the plan’s resource tests. Add a large-file streaming test/profile and explicit limits on image dimensions/decompression bombs.

- **Task 12 — the CORS script replaces the bucket’s complete CORS configuration.**  
  `PutBucketCorsCommand` writes one rule and discards any existing rules. This can break other bucket consumers. Read existing rules, merge/update the Lanka origin rule deterministically, or explicitly require and verify that this bucket has no other CORS users.

- **Tasks 6/7 — configured size is not clamped to single-PUT/R2 limits.**  
  An operator can set `MAX_UPLOAD_BYTES` above 5 GiB even though this design uses a single PUT. Validate configuration at startup and clamp/reject values above the supported backend limit and JavaScript-safe integer range.

- **Task 10 — the modal can close without aborting an active upload.**  
  `@update:open="(v) => emit(...)"` bypasses `cancel()`. Backdrop/Escape closure can hide a still-running upload and its progress/error state. Intercept close events while uploading and call `cancel()`, or make the modal non-dismissible during transfer.

- **Task 10 — retry changes the originally selected quality.**  
  Failed rows remain, but retry reads the current global `quality.value`, not the quality used for that item’s first ticket. Store quality per item or reset failed items explicitly when quality changes.

- **Task 9 — polling requests are sequential.**  
  `for (...) await getUpload(...)` means many tracked jobs can make a nominal 3-second poll take much longer. Use bounded `Promise.allSettled`, then apply results once per tick.

- **Task 9 — repeated failure results can generate duplicate toasts.**  
  `applyUpload()` pushes every terminal failure into `failedUploads` without checking whether that job was already recorded. Concurrent/repeated polling paths can toast the same job more than once. Deduplicate terminal job IDs.

- **Spec/plan gap — configurable maximum-size UI is not implemented.**  
  The spec promises “Max {n} GB per file,” but Task 10 replaces the old 500 MB description without exposing the configured limit to the client. Add a public safe limit endpoint/config value and validate files before creating jobs.

- **Spec/plan gap — `drain()`/`size` changed to `idle()` without reconciling the design.**  
  The approved design names `{ enqueue, drain, recover, sweep, size }`; the plan implements neither `drain` nor observable queue size. Either update the design explicitly or implement the promised operational/testing surface.

- **Tests — queue test does not cover the dangerous races.**  
  No test concurrently invokes complete/complete, complete/cancel, two worker instances, or restart between database transition and enqueue. Add deterministic concurrency tests around conditional state transitions.

- **Tests — no transient-failure or restart durability tests.**  
  Tests cover only successful ingest and permanent failure. Add R2 open/delete outages, database update failure, recovery after worker interruption, queued-but-not-enqueued reconciliation, and retained staged data during retry.

- **Tests — the FIFO assertion is timing-dependent.**  
  ```ts
  await new Promise((r) => setTimeout(r, 20))
  ```
  can be flaky under loaded CI. Signal explicitly when the first fake ingest starts, await that promise, then assert the second has not started.

- **Tests — API handlers are tested without auth/routing integration.**  
  Pure handler tests cannot prove the routes are session-gated or that `/api/media/uploads` resolves ahead of `/api/media/[id]`. Add a small Nitro integration test covering route resolution and unauthenticated/client/admin access.

- **Tests — no Vue dialog test despite cancellation and closure complexity.**  
  Build-only verification will not catch Escape/backdrop closure, abort sequencing, retry behavior, sequential ordering, or per-file state. Add component tests with a mocked store and fake timers.

## Minor

- **Task 8 — abort listeners are never removed.**  
  The `AbortSignal` listener remains after XHR completion. Remove it in a shared settle/cleanup path and guard against multiple settlements.

- **Task 8 tests — the same rejected promise is asserted twice.**  
  Calling both `await expect(p).rejects...` assertions on one promise can produce awkward unhandled-rejection behavior. Catch once or combine assertions on the captured error.

- **Task 6 — filename truncation can split a Unicode surrogate pair.**  
  `.slice(0, 255)` counts UTF-16 code units, not characters or UTF-8 bytes. Normalize and cap by a documented byte/character policy.

- **Task 5 — unexpected errors may leave jobs in `processing`.**  
  The initial `processing` update is outside the try block, and failures in failure-recording are only logged by the outer loop. Wrap the complete claim/process/finalization path and ensure an observable recoverable state.

- **Task 13 — the image smoke test uses random bytes labelled PNG.**  
  This verifies the current unsafe trust of client MIME rather than valid image handling. Use a real generated PNG and add an explicit invalid-image rejection check.

Verdict: **implement with these changes**.
## Triage (accepted / rejected, verified against the repo)

# Triage of Codex review round 1 (by Claude, verified against the repo)

Context facts checked in the repo: single Docker Compose service (one Nitro process); better-sqlite3 is synchronous but handlers `await` between statements so requests can interleave; `tests/integration/*` are handler-level (no Nitro server, no routing harness); `tests/components/*` are pure-logic tests (no @vue/test-utils / jsdom devDeps); Nuxt UI v3 `UModal` has a `dismissible` prop; `fs.promises.statfs` exists (Node 22); media served to TVs from a PUBLIC CDN by design (signage content is public).

## ACCEPTED (will change the plan)
C1 Transient vs permanent failures: worker will classify — errors carrying `statusCode` 4xx from ingestMedia (400 empty / 422 unprocessable) = permanent → `failed` + delete staged; anything else (R2 GET, disk, DB) = retryable → keep staged, `attempts++`, back to `queued`, re-enqueue after 30 s × attempts; after MAX_ATTEMPTS=3 → `failed` + delete.
C2 Atomic transitions: `complete` = `UPDATE … SET status='queued' WHERE id=? AND status='pending' RETURNING`; `cancel` = conditional `DELETE … WHERE status='pending'` then delete staged; worker claim = `UPDATE … SET status='processing', attempts=attempts+1 WHERE id=? AND status='queued' RETURNING` — no row ⇒ skip. This also covers C3 (a second process cannot double-claim); no lease tokens (single-instance stays the documented assumption).
C4 Boot cleanup of stale `lanka-ingest-*` dirs in tmpdir (older than 2 h) in the plugin.
I5 `complete` idempotent: if status is queued/processing/done return the job (200) instead of 409; 409 only for failed/expired.
I6 Presign before insert.
I7 Local PUT requires `seen === declared` at flush; delete staged on any receive failure.
I10 R2 lifecycle rule for `uploads/` (expire after 1 day) added to the bucket setup script as a storage-level backstop.
I13/I14 Periodic maintenance every 5 min = `sweep()` + `recover()` (re-enqueue queued rows; harmless with the atomic claim). Boot recovery failure therefore self-heals.
I15 Preflight free-space check in the worker (`statfs(tmpdir)`; need ≥ 2.5 × bytes + 512 MB) → treated as retryable.
I17 CORS script merges with existing rules instead of replacing.
I18 Clamp `maxUploadBytes` to ≤ 5 GiB (single-PUT limit).
I19 `UModal :dismissible="!uploading"`; `update:open` routed through `cancel()`.
I21 Poll with `Promise.allSettled`.
I22 Dedupe `failedUploads` by id.
I23/I24 Spec updated to match the plan (`idle()` instead of `drain()/size`; no "Max {n} GB" copy — the 413 message carries the number).
T25/T26/T27 Tests: concurrent complete/complete and complete/cancel (exactly one wins); retryable vs permanent failure (staged retained vs deleted); FIFO test signals "first ingest started" via a promise instead of a 20 ms sleep.
M30–M34 all accepted (abort listener cleanup; capture rejection once; `Array.from(name).slice(0,255)`; claim inside try; real 1×1 PNG in the smoke test).
Also found by me: `tests/integration/admin-flow.test.ts` imports `ingestMedia` from `~/server/api/media.post` — Task 2 must update it too.

## REJECTED / DEFERRED (with reasons) — challenge these if you disagree
R8 Local `PUT /file` replay / concurrent overwrite: this transport is only handed out by LocalDiskStore (dev/tests, no R2). `putAtomic` renames atomically and `/complete` verifies the size. Not worth a nonce.
R9 Presigned-PUT TOCTOU (overwrite after /complete within the 1 h window): the only holder of the ticket is the authenticated admin who created it and whose own browser performs the PUT. Overwriting your own upload mid-ingest is not a privilege escalation. Deferred; noted.
R11 Public staged objects: accepted risk — all media is public signage content served from a public CDN already; spec will state "non-confidential" explicitly. A private staging bucket is extra config for no real gain here.
R12 Image validation (SVG/HTML via the media domain): pre-existing behaviour of the current synchronous endpoint, unchanged by this feature; recorded as a follow-up in docs/audit-2026-06-28-followups.md rather than scope-creeping this plan.
R16 Memory profile of thumbnails: pre-existing code path (sharp stream → buffer; ffmpeg first frame), unchanged.
R20 Retry uses the currently selected quality: acceptable UX (the user may deliberately change quality before retrying).
R28 Nitro integration test for routing/auth: no Nitro-server test harness exists in this repo; route precedence + auth gating will be verified with curl in Task 13 (GET /api/media/uploads vs /api/media/:id; unauthenticated 401; client role 403).
R29 Vue component test for the dialog: no @vue/test-utils/jsdom in the project. Instead: extract the dialog's pure state logic into `MediaUploadDialog.logic.ts` (kindOf, per-item state transitions, "close allowed?" rule) and unit-test that, matching the existing `PlaylistEditor.logic.ts` pattern.

## Round 2 — Codex on the disputed items + sanity check of the accepted design

R8 — A cancelled/slow first PUT can finish after a retry’s PUT and `/complete`; its atomic rename then replaces the verified bytes with different same-sized content before ingestion.

R9 — agree.

R11 — agree.

R12 — agree.

R16 — A decompression-bomb image can OOM-kill Nitro; recovery retries it after every restart, producing a crash loop before `MAX_ATTEMPTS` can be durably exhausted.

R20 — agree.

R28 — A later middleware/config refactor can omit admin authorization from one new route; handler tests remain green and the one-time curl check will not prevent deployment of an anonymously cancellable upload endpoint.

R29 — Pure state tests cannot detect incorrect `UModal` wiring: Escape/backdrop may emit `update:open=false` while uploading without invoking `cancel()`, leaving the XHR and pending job alive.

C1/C2 sanity check:

- Periodic `recover()` is unsafe without distinguishing live work from interrupted work. At minute 5 of a legitimate 30-minute transcode, it sees `processing`, resets it to `queued`, and enqueues it. On a later sweep it can reach the attempt limit, mark it failed, and delete staging while the original attempt still runs.
- Consequently the original worker can later overwrite `failed` with `done`; or, after failing, its duplicate FIFO entry can claim the job and process it again. Atomic claim prevents simultaneous claims, but not this reprocessing.
- `recover()` must run for `processing` rows only at boot, or use an owner/lease/heartbeat. Periodic maintenance should re-enqueue only `queued` rows and sweep stale `pending` rows.
- Complete’s `statStaged` is outside the transition. If cancel deletes the pending row after that stat, complete’s conditional update returns no row. The handler must treat that as a lost race and must not enqueue or dereference an absent `RETURNING` result.
- A crash after `pending → queued` but before `enqueue()` leaves the job dormant for up to five minutes, but periodic queued recovery eventually repairs it.
- A crash after ingest commits media but before `processing → done` can execute ingestion twice after boot. This is safe only if `ingestMedia` is transactionally/idempotently deduplicated, including generated files and reference updates.
- Transitions followed by staged deletion can leak an object on crash, but should not lose a retryable object. Never delete staging before the terminal status update commits.

Accepted-list concerns:

- I13/I14’s periodic full `recover()` is a correctness bug, not merely over-engineering; split boot recovery from periodic queued reconciliation.
- I15’s exact `2.5 × bytes + 512 MB` gate is speculative complexity for this deployment and may reject workable uploads. A simpler fixed reserve or operational disk limit is enough initially.
- C4’s bespoke two-hour temp-directory scavenger is arguably unnecessary if ingestion always uses managed temp directories and container restart cleanup; retain it only if interrupted ffmpeg/sharp work demonstrably leaves persistent host files.
- `Array.from(name).slice(0,255)` is Unicode-aware polish beyond the prototype’s needs and still does not enforce the database/filesystem byte limit.
## Resolution after round 2

- Periodic `recover()` was a real bug (would re-queue a live transcode) → split into boot-only `recover()` and periodic `reconcile()` (queued rows only).
- `/complete` handles the lost race (conditional update returned no row → re-read; never enqueue a deleted row).
- Preflight simplified to `2 × bytes + 256 MiB`; tmp scavenger kept (container /tmp survives crash restarts; 11 GB disk).
- Auth policy for the new routes pinned in `tests/services/auth-guard.test.ts` (R28); dialog pure logic extracted + `:dismissible="!uploading"` (R29).
- R8 stays rejected: the dashboard always creates a *new* job id after an aborted PUT, so a stale PUT can never land on a verified key. R9/R11/R12/R16/R20 accepted as stated (R16's crash loop is bounded by `MAX_ATTEMPTS`).
