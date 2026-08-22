// server/services/media-ingest-queue.ts
//
// Single in-process worker that turns staged uploads (media_uploads rows whose
// bytes already sit in the media store under uploads/<id>) into media rows by
// running the same ingestMedia() the synchronous endpoint uses.
//
// - Concurrency 1 on purpose: ffmpeg already saturates the 2-vCPU prod box.
// - Claiming is an atomic conditional UPDATE (queued → processing), so a row is
//   never processed twice — even if a second process shows up during a deploy.
// - Failures are classified: h3 4xx from ingestMedia (empty / unprocessable) are
//   permanent → failed + staged object deleted. Everything else (R2, disk, DB,
//   preflight) is retryable → staged object kept, back to queued, retried with
//   a linear backoff, failed after MAX_ATTEMPTS claims.
import { readdir, rm, stat, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import type { MediaStore } from './media-store'
import { ingestMedia, type IngestInput, type IngestedMedia } from './media-ingest'

type Db = BetterSQLite3Database<typeof schema>

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_ATTEMPTS = 3
export const RETRY_DELAY_MS = 30_000
export const TMP_STALE_MS = 2 * 60 * 60 * 1000
const SCRATCH_HEADROOM_BYTES = 256 * 1024 ** 2

export type IngestFn = (db: Db, store: MediaStore, input: IngestInput) => Promise<IngestedMedia>

export interface IngestQueue {
  enqueue(id: string): void
  idle(): Promise<void>
  /** BOOT ONLY — resets `processing` rows left by the previous process, then reconcile(). */
  recover(): Promise<void>
  /** Safe any time — enqueues every `queued` row (lost in-memory enqueue after a crash). */
  reconcile(): Promise<void>
  sweep(now?: number): Promise<number>
}

/** ingestMedia signals "this file is bad" with h3 4xx errors; everything else is infrastructure. */
export function isPermanentIngestError(err: unknown): boolean {
  const code = (err as { statusCode?: unknown } | null)?.statusCode
  return typeof code === 'number' && code >= 400 && code < 500
}

/** Worst case on disk at once: the downloaded input + the transcoded output, plus headroom. */
export function requiredScratchBytes(bytes: number): number {
  return 2 * bytes + SCRATCH_HEADROOM_BYTES
}

async function defaultFreeBytes(): Promise<number> {
  const s = await statfs(tmpdir())
  return Number(s.bavail) * Number(s.bsize)
}

/** Remove abandoned ingest scratch dirs (a SIGKILL mid-transcode skips ingestMedia's finally). */
export async function cleanupStaleTmp(now: number = Date.now(), dir: string = tmpdir()): Promise<number> {
  let removed = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith('lanka-ingest-')) continue
    const p = join(dir, name)
    try {
      const s = await stat(p)
      if (s.isDirectory() && now - s.mtimeMs > TMP_STALE_MS) {
        await rm(p, { recursive: true, force: true })
        removed++
      }
    } catch {
      // vanished meanwhile — ignore
    }
  }
  return removed
}

export function createIngestQueue(deps: {
  db: Db
  store: MediaStore
  ingest?: IngestFn
  log?: (msg: string, meta?: unknown) => void
  retryDelayMs?: number
  freeBytes?: () => Promise<number>
}): IngestQueue {
  const { db, store } = deps
  const ingest = deps.ingest ?? ingestMedia
  const log = deps.log ?? ((msg, meta) => console.warn(msg, meta ?? ''))
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS
  const freeBytes = deps.freeBytes ?? defaultFreeBytes

  const fifo: string[] = []
  const inFifo = new Set<string>()
  let running: Promise<void> | null = null
  let pendingRetries = 0
  let idleWaiters: (() => void)[] = []

  const now = () => new Date()

  async function deleteStagedQuiet(id: string): Promise<void> {
    try {
      await store.deleteStaged(id)
    } catch (err) {
      log('[ingest-queue] could not delete staged object', { id, err: (err as Error).message })
    }
  }

  /** Atomic claim: only a `queued` row flips to `processing`; returns the claimed row or undefined. */
  async function claim(id: string) {
    const [row] = await db
      .update(schema.mediaUploads)
      .set({ status: 'processing', attempts: sql`${schema.mediaUploads.attempts} + 1`, updatedAt: now() })
      .where(and(eq(schema.mediaUploads.id, id), eq(schema.mediaUploads.status, 'queued')))
      .returning()
    return row
  }

  async function processOne(id: string): Promise<void> {
    const row = await claim(id)
    if (!row) return // cancelled / expired / already taken / unknown
    try {
      const free = await freeBytes()
      const need = requiredScratchBytes(row.bytes)
      if (free < need) {
        throw new Error(`Not enough free disk space for ingest (need ${need} bytes, have ${free})`)
      }
      const stream = await store.openStaged(id)
      // A ReadStream's fd open() happens lazily; if `ingest` never touches
      // the stream (permanent-failure short-circuit, or a test double), an
      // unrelated later unlink() can race it and fire an 'error' with no
      // listener, crashing the process. Swallow it here — a real read error
      // still reaches `ingest`'s own rejection via its consumption path.
      stream.on('error', () => {})
      const media = await ingest(db, store, {
        stream,
        filename: row.filename,
        kind: row.kind,
        mimeType: row.mimeType,
        quality: row.quality
      })
      await db
        .update(schema.mediaUploads)
        .set({ status: 'done', mediaId: media.id, error: null, updatedAt: now() })
        .where(eq(schema.mediaUploads.id, id))
      await deleteStagedQuiet(id)
    } catch (err) {
      const message = (err as Error)?.message || 'Ingest failed'
      const exhausted = row.attempts >= MAX_ATTEMPTS
      if (isPermanentIngestError(err) || exhausted) {
        await db
          .update(schema.mediaUploads)
          .set({
            status: 'failed',
            error: exhausted && !isPermanentIngestError(err) ? `${message} (gave up after ${row.attempts} attempts)` : message,
            updatedAt: now()
          })
          .where(eq(schema.mediaUploads.id, id))
        await deleteStagedQuiet(id)
        return
      }
      // Retryable: keep the staged object, surface the last error, back off.
      await db
        .update(schema.mediaUploads)
        .set({ status: 'queued', error: message, updatedAt: now() })
        .where(eq(schema.mediaUploads.id, id))
      log('[ingest-queue] retryable failure, will retry', { id, attempt: row.attempts, err: message })
      pendingRetries++
      const t = setTimeout(() => {
        pendingRetries--
        enqueue(id)
      }, retryDelayMs * row.attempts)
      t.unref?.()
    }
  }

  async function loop(): Promise<void> {
    while (fifo.length > 0) {
      const id = fifo.shift()!
      inFifo.delete(id)
      try {
        await processOne(id)
      } catch (err) {
        // Only reachable if a status write itself failed; the row stays
        // `processing` and recover() picks it up on the next maintenance tick.
        log('[ingest-queue] unexpected error', { id, err: (err as Error).message })
      }
    }
    running = null
    settleIdle()
  }

  function settleIdle() {
    if (running || fifo.length > 0 || pendingRetries > 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const w of waiters) w()
  }

  function enqueue(id: string): void {
    if (inFifo.has(id)) return
    fifo.push(id)
    inFifo.add(id)
    if (!running) running = loop()
  }

  function idle(): Promise<void> {
    if (!running && fifo.length === 0 && pendingRetries === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  async function reconcile(): Promise<void> {
    const queued = await db
      .select({ id: schema.mediaUploads.id })
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.status, 'queued'))
      .orderBy(asc(schema.mediaUploads.createdAt))
    for (const r of queued) enqueue(r.id)
  }

  // Boot only: nothing else is running, so every `processing` row is an
  // interrupted attempt. Running this periodically would reset live jobs.
  async function recover(): Promise<void> {
    const stuck = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.status, 'processing'))
    for (const row of stuck) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await db
          .update(schema.mediaUploads)
          .set({ status: 'failed', error: 'Interrupted during processing', updatedAt: now() })
          .where(eq(schema.mediaUploads.id, row.id))
        await deleteStagedQuiet(row.id)
      } else {
        await db
          .update(schema.mediaUploads)
          .set({ status: 'queued', updatedAt: now() })
          .where(eq(schema.mediaUploads.id, row.id))
      }
    }
    await reconcile()
  }

  async function sweep(at: number = Date.now()): Promise<number> {
    const stale = await db
      .select()
      .from(schema.mediaUploads)
      .where(
        and(
          eq(schema.mediaUploads.status, 'pending'),
          lt(schema.mediaUploads.createdAt, new Date(at - PENDING_TTL_MS))
        )
      )
    for (const row of stale) {
      await deleteStagedQuiet(row.id)
      await db
        .update(schema.mediaUploads)
        .set({ status: 'expired', error: 'Upload was never completed', updatedAt: new Date(at) })
        .where(eq(schema.mediaUploads.id, row.id))
    }
    return stale.length
  }

  return { enqueue, idle, recover, reconcile, sweep }
}
