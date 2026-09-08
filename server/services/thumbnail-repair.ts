// server/services/thumbnail-repair.ts
//
// Restores the invariant `media.thumbnail_bytes != null  ⟺  the store holds
// thumbs/<sha256>.jpg`.
//
// MediaCard renders its <img> off the column and /media/:sha/thumb serves off
// the object, so the two drifting apart shows the operator a broken image with
// no error anywhere. That is exactly what the 2026-09-06 no-audio transcode
// backfill did on prod: it rewrote media.sha256 to the re-encoded hash, left
// the thumbnail under the OLD hash, and left the column set.
//
// Ships in the runtime image (like transcode-existing.ts) so it can be run
// against a live box: `pnpm tsx scripts/backfill-thumbnails.ts`.
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import type { MediaStore } from './media-store'
import { storeThumbnailFromFile } from './thumbnails'

export interface RepairResult {
  scanned: number
  /** Rows whose thumbnail was already present. */
  ok: number
  /** Rows whose thumbnail was regenerated (or would be, under dryRun). */
  repaired: number
  /** Rows that have no usable thumbnail; thumbnail_bytes was cleared. */
  failed: number
}

export interface RepairOptions {
  /** Report the work without touching the store or the DB. */
  dryRun?: boolean
  log?: (msg: string) => void
}

/**
 * Regenerates every missing thumbnail from the media object it belongs to.
 * Idempotent: a row whose thumbnail is present is probed and skipped, so this
 * is safe to re-run and cheap on a healthy fleet.
 */
export async function repairMissingThumbnails(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  opts: RepairOptions = {}
): Promise<RepairResult> {
  const log = opts.log ?? (() => {})
  const res: RepairResult = { scanned: 0, ok: 0, repaired: 0, failed: 0 }

  const rows = await db.select().from(schema.media)

  for (const row of rows) {
    res.scanned++
    const label = `[media id=${row.id} sha=${row.sha256.slice(0, 12)}… ${row.filename}]`

    if (await store.hasThumbnail(row.sha256)) {
      res.ok++
      continue
    }

    if (opts.dryRun) {
      log(`${label} WOULD regenerate thumbnail`)
      res.repaired++
      continue
    }

    // Pull the object to a tmp file: ffmpeg needs a seekable source, and sharp
    // buffers the whole image anyway.
    const tmpDir = await mkdtemp(join(tmpdir(), 'lanka-thumb-repair-'))
    const tmpPath = join(tmpDir, 'in.bin')
    try {
      await pipeline(await store.open(row.sha256), createWriteStream(tmpPath))
      const bytes = await storeThumbnailFromFile(store, row.sha256, row.kind, tmpPath)
      await db
        .update(schema.media)
        .set({ thumbnailBytes: bytes })
        .where(eq(schema.media.id, row.id))
      log(`${label} regenerated thumbnail (${bytes} B)`)
      res.repaired++
    } catch (err) {
      // No thumbnail is better than a broken one: a null column makes the card
      // render the kind icon instead of a dead <img>.
      log(`${label} FAILED: ${(err as Error).message}`)
      if (row.thumbnailBytes !== null) {
        await db
          .update(schema.media)
          .set({ thumbnailBytes: null })
          .where(eq(schema.media.id, row.id))
      }
      res.failed++
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  return res
}
