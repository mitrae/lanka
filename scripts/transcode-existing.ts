/**
 * scripts/transcode-existing.ts
 *
 * ONE-OFF Phase-3 maintenance script — NOT part of the test suite, NOT on the
 * request path. Run manually after deploying Tasks 1–3 (transcode service +
 * upload-time transcoding + upload endpoint update) to backfill any videos
 * already in the store that are not yet kiosk-safe.
 *
 * Usage:
 *   pnpm tsx scripts/transcode-existing.ts --dry-run   # preview, no mutations
 *   pnpm tsx scripts/transcode-existing.ts              # apply
 *   pnpm tsx scripts/transcode-existing.ts --delete-old # apply + remove old objects
 *
 * On a production server, inside the container (the runtime image ships this
 * script and server/services/* precisely so this works — see the Dockerfile):
 *   docker compose exec lanka sh -c 'set -a; . /app/.env 2>/dev/null; set +a; \
 *     pnpm tsx scripts/transcode-existing.ts --dry-run'
 *
 * Env vars read (same as the app):
 *   DATABASE_URL          — defaults to file:./data/signage.db
 *   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *                         — or the NUXT_R2_* names prod's .env actually uses.
 *                           All four set: R2Store. None set: LocalDiskStore.
 *                           Some set: throws, rather than silently scanning an
 *                           empty local dir on a box whose media lives in R2.
 *   MEDIA_DIR             — local disk store root (default ./data/media)
 *
 * Idempotent: conforming clips are probed and skipped; safe to re-run.
 */

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

import { eq } from 'drizzle-orm'

import { openDatabase } from '../server/db/client'
import * as schema from '../server/db/schema'
import { LocalDiskStore } from '../server/services/media-store'
import { R2Store } from '../server/services/r2-store'
import type { MediaStore } from '../server/services/media-store'
import { ensureQuality, probeVideo, isKioskSafe } from '../server/services/transcode'
import { bumpPlaylistVersion } from '../server/services/playlist-version'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const DELETE_OLD = args.includes('--delete-old')

// ---------------------------------------------------------------------------
// Store selection (mirrors media-store-singleton logic without Nitro context)
// ---------------------------------------------------------------------------

/** Accepts either the bare name or the NUXT_-prefixed one. Production's .env
 *  uses NUXT_R2_* (the app reads it through runtimeConfig), so honouring only
 *  the bare names made this script silently pick LocalDiskStore on the very box
 *  it is meant to be run on — see the throw below. Mirrors import-r2-object.ts. */
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
  // disk. Falling through would scan against a near-empty ./data/media on a
  // prod box where R2 holds every object, and report a wall of per-row errors
  // that look like corrupt media rather than a missing variable.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function streamToFile(readable: NodeJS.ReadableStream, destPath: string): Promise<void> {
  await pipeline(readable, createWriteStream(destPath))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `\n=== transcode-existing.ts | dry-run=${DRY_RUN} delete-old=${DELETE_OLD} ===\n`
  )

  const dbUrl = process.env.DATABASE_URL ?? 'file:./data/signage.db'
  console.log(`[db] opening ${dbUrl}`)
  const db = openDatabase(dbUrl)
  const store = buildStore()

  // Fetch all video rows
  const videos = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.kind, 'video'))

  console.log(`[scan] found ${videos.length} video row(s)\n`)

  let countScanned = 0
  let countSkipped = 0
  let countTranscoded = 0
  let countErrors = 0

  for (const row of videos) {
    countScanned++
    const label = `[media id=${row.id} sha=${row.sha256.slice(0, 12)}…]`
    let tmpDir: string | null = null

    try {
      // Create an isolated tmp directory for this row
      tmpDir = await mkdtemp(join(tmpdir(), 'lanka-transcode-'))

      // Download the media object to a local tmp file
      const tmpIn = join(tmpDir, 'input')
      const readable = await store.open(row.sha256)
      await streamToFile(readable as NodeJS.ReadableStream, tmpIn)

      // --- Probe first, in BOTH modes ---
      // The conforming-skip has to gate the real run too, not just the preview:
      // ensureQuality always re-encodes, so without this a re-run rewrites every
      // row — new sha, new bytes, another generation of lossy re-encode, and a
      // playlist version bump per file. That is the opposite of the idempotence
      // this script's header promises, and it is what made a re-run silently
      // re-encode an already-safe 720p30 clip.
      const sourceProbe = await probeVideo(tmpIn)
      if (isKioskSafe(sourceProbe)) {
        console.log(`${label} skip (already conforming)`)
        countSkipped++
        continue
      }
      if (DRY_RUN) {
        console.log(
          `${label} [dry-run] WOULD transcode:\n` +
          `  current: profile=${sourceProbe.profile} codec=${sourceProbe.codec} pixFmt=${sourceProbe.pixFmt} ` +
          `dims=${sourceProbe.width}x${sourceProbe.height} fps=${sourceProbe.frameRate.toFixed(2)} ` +
          `level=${sourceProbe.level} bytes=${row.bytes}`
        )
        countTranscoded++
        continue
      }

      // --- Real run: transcode + re-probe ---
      const { path: finalPath, probe } = await ensureQuality(tmpIn, tmpDir, 'standard')

      // Compute new sha256
      const newSha = await hashFile(finalPath)
      const newBytes = statSync(finalPath).size

      if (newSha === row.sha256) {
        // Shouldn't happen when transcoded=true, but guard anyway
        console.log(`${label} skip (sha unchanged after transcode — unexpected)`)
        countSkipped++
        continue
      }

      // Collision guard: another media row might already have this sha
      const existing = await db
        .select({ id: schema.media.id })
        .from(schema.media)
        .where(eq(schema.media.sha256, newSha))

      if (existing.length > 0 && existing[0].id !== row.id) {
        console.warn(
          `${label} WARN: output sha ${newSha.slice(0, 12)}… already belongs to media id=${existing[0].id}; skipping to avoid UNIQUE violation`
        )
        countErrors++
        continue
      }

      console.log(
        `${label} transcoded:\n` +
        `  old: sha=${row.sha256.slice(0, 12)}… bytes=${row.bytes} dims=${row.width}x${row.height}\n` +
        `  new: sha=${newSha.slice(0, 12)}… bytes=${newBytes} dims=${probe.width}x${probe.height} durationMs=${probe.durationMs}`
      )

      // 1. Upload the transcoded file
      await store.put(newSha, createReadStream(finalPath), 'video/mp4')

      // 2. Update the media row
      //
      // NOTE: steps 2-3 (row update + playlist version bumps) are NOT atomic
      // with the store.put above. If the process dies AFTER this row is updated
      // to newSha but BEFORE all bumpPlaylistVersion calls complete, those
      // playlists won't re-sync — and a re-run will NOT fix them: the row now
      // conforms (newSha is kiosk-safe) so it gets skipped. Recovery is manual:
      // re-bump the affected playlists (or just re-save them in the dashboard).
      // We deliberately do NOT wrap this in db.transaction() — better-sqlite3
      // transactions are synchronous and would force rewriting these awaited
      // calls; not worth it for a one-off backfill.
      const oldSha = row.sha256
      await db
        .update(schema.media)
        .set({
          sha256: newSha,
          sourceSha256: oldSha,
          mimeType: 'video/mp4',
          bytes: newBytes,
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          // The backfill always re-encodes at `standard`; leaving a stale
          // `high` here would have the dashboard advertise a quality the bytes
          // no longer are.
          quality: 'standard',
        })
        .where(eq(schema.media.id, row.id))

      // 3. Bump playlist versions for any playlist containing this media
      const items = await db
        .select({ playlistId: schema.playlistItems.playlistId })
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.mediaId, row.id))

      const distinctPids = [...new Set(items.map((i) => i.playlistId))]
      for (const pid of distinctPids) {
        await bumpPlaylistVersion(db, pid)
        console.log(`${label} bumped playlist id=${pid}`)
      }

      // 4. Optionally delete the old object
      if (DELETE_OLD) {
        await store.delete(oldSha)
        console.log(`${label} deleted old object ${oldSha.slice(0, 12)}…`)
      }

      console.log(`${label} done`)
      countTranscoded++
    } catch (err) {
      console.error(`${label} ERROR:`, err)
      countErrors++
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true })
      }
    }
  }

  console.log(`
=== Summary ===
  scanned:   ${countScanned}
  conforming (skipped): ${countSkipped}
  ${DRY_RUN ? 'would transcode' : 'transcoded'}:  ${countTranscoded}
  errors:    ${countErrors}
`)

  process.exit(countErrors > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
