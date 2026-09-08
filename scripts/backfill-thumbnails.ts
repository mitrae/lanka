/**
 * scripts/backfill-thumbnails.ts
 *
 * Repairs media rows that claim a thumbnail the store does not have. The
 * dashboard renders <img src="/media/<sha>/thumb"> whenever
 * `media.thumbnail_bytes` is set, and the route 404s off the object — so a row
 * where those two disagree is a permanently broken image with no error in any
 * log.
 *
 * How prod got there: the 2026-09-06 no-audio transcode backfill rewrote
 * `media.sha256` to the re-encoded hash but left the thumbnail under the old
 * one. `transcode-existing.ts` now re-keys the thumbnail itself; this script
 * fixes rows that were already rewritten (they conform now, so the transcode
 * backfill skips them and will never fix them on its own).
 *
 * Usage:
 *   pnpm tsx scripts/backfill-thumbnails.ts --dry-run   # preview, no mutations
 *   pnpm tsx scripts/backfill-thumbnails.ts             # apply
 *
 * On a production server, inside the container:
 *   docker compose exec lanka sh -c 'set -a; . /app/.env 2>/dev/null; set +a; \
 *     pnpm tsx scripts/backfill-thumbnails.ts --dry-run'
 *
 * Env vars read: the same set as transcode-existing.ts (DATABASE_URL, the
 * R2_* / NUXT_R2_* quad, MEDIA_DIR).
 *
 * Idempotent: rows whose thumbnail is present are probed and skipped.
 */

import { openDatabase } from '../server/db/client'
import { LocalDiskStore } from '../server/services/media-store'
import { R2Store } from '../server/services/r2-store'
import type { MediaStore } from '../server/services/media-store'
import { repairMissingThumbnails } from '../server/services/thumbnail-repair'

const DRY_RUN = process.argv.slice(2).includes('--dry-run')

/** Accepts either the bare name or the NUXT_-prefixed one — production's .env
 *  uses NUXT_R2_* (the app reads it through runtimeConfig). Mirrors
 *  transcode-existing.ts / import-r2-object.ts. */
function r2Env(suffix: string): string | undefined {
  return process.env[`R2_${suffix}`] ?? process.env[`NUXT_R2_${suffix}`]
}

function buildStore(): MediaStore {
  const endpoint = r2Env('ENDPOINT')
  const bucket = r2Env('BUCKET')
  const accessKeyId = r2Env('ACCESS_KEY_ID')
  const secretAccessKey = r2Env('SECRET_ACCESS_KEY')

  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    console.log('[store] using R2Store')
    return new R2Store({ endpoint, bucket, accessKeyId, secretAccessKey })
  }

  // Partially-set R2 config is a misconfiguration, not a request for local
  // disk: falling through would report every row as missing on a box whose
  // objects all live in R2, and then null every thumbnail_bytes column.
  if (endpoint || bucket || accessKeyId || secretAccessKey) {
    throw new Error(
      'R2 is partially configured (need ENDPOINT, BUCKET, ACCESS_KEY_ID and ' +
      'SECRET_ACCESS_KEY, as R2_* or NUXT_R2_*); refusing to fall back to local disk'
    )
  }

  const dir = process.env.MEDIA_DIR ?? './data/media'
  console.log(`[store] using LocalDiskStore at ${dir}`)
  return new LocalDiskStore(dir)
}

async function main(): Promise<void> {
  console.log(`\n=== backfill-thumbnails.ts | dry-run=${DRY_RUN} ===\n`)

  const dbUrl = process.env.DATABASE_URL ?? 'file:./data/signage.db'
  console.log(`[db] opening ${dbUrl}`)
  const db = openDatabase(dbUrl)
  const store = buildStore()

  const res = await repairMissingThumbnails(db, store, {
    dryRun: DRY_RUN,
    log: (msg) => console.log(msg)
  })

  console.log(`
=== Summary ===
  scanned:   ${res.scanned}
  present (skipped): ${res.ok}
  ${DRY_RUN ? 'would regenerate' : 'regenerated'}: ${res.repaired}
  failed (thumbnail_bytes cleared): ${res.failed}
`)

  process.exit(res.failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
