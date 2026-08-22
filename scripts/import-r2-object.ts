/**
 * One-off: register an object that was uploaded to the media bucket BY HAND
 * (e.g. `media/IMG_0007.MP4` via the Cloudflare dashboard) as a proper media
 * row — i.e. run it through the same ingest the upload endpoint uses:
 * sha256 → probe → transcode to kiosk-safe (unless already conforming) →
 * store under media/<sha> → thumbnail → `media` row.
 *
 * Usage (inside the prod container, as the runtime user):
 *   docker cp /opt/lanka/scripts lanka:/app/src/scripts && docker cp /opt/lanka/server lanka:/app/src/server
 *   docker exec -u 10001 -w /app/src -e DATABASE_URL=file:/app/data/signage.db lanka \
 *     node /app/node_modules/.bin/tsx scripts/import-r2-object.ts \
 *       --key media/IMG_0007.MP4 --filename IMG_0007.MP4 --quality standard
 *
 * Reads R2_* or NUXT_R2_* env. Never deletes the source object.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { openDatabase } from '../server/db/client'
import * as schema from '../server/db/schema'
import { R2Store } from '../server/services/r2-store'
import { ensureQuality, isKioskSafe, probeVideo, type QualityPreset } from '../server/services/transcode'
import { generateVideoThumbnail } from '../server/services/thumbnails'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  console.error(`missing --${name}`)
  process.exit(1)
}
function env(...names: string[]): string {
  for (const n of names) if (process.env[n]) return process.env[n]!
  console.error(`missing env ${names.join(' | ')}`)
  process.exit(1)
}

async function hashFile(p: string): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(p)) h.update(c as Buffer)
  return h.digest('hex')
}

async function main() {
  const key = arg('key')                       // e.g. media/IMG_0007.MP4
  const filename = arg('filename', key.split('/').pop()!)
  const quality = arg('quality', 'standard') as QualityPreset
  if (!['low', 'standard', 'high'].includes(quality)) throw new Error('bad --quality')
  if (!key.startsWith('media/')) throw new Error('--key must be under media/ (R2Store.open() maps media/<x>)')
  const force = process.argv.includes('--force-transcode')

  const db = openDatabase(env('DATABASE_URL'))
  const store = new R2Store({
    endpoint: env('R2_ENDPOINT', 'NUXT_R2_ENDPOINT'),
    bucket: env('R2_BUCKET', 'NUXT_R2_BUCKET'),
    accessKeyId: env('R2_ACCESS_KEY_ID', 'NUXT_R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY', 'NUXT_R2_SECRET_ACCESS_KEY')
  })

  const tmp = await mkdtemp(join(tmpdir(), 'lanka-import-'))
  const t0 = Date.now()
  const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  try {
    // R2Store.open(x) reads key media/<x>; strip the prefix.
    const inPath = join(tmp, 'in.bin')
    log(`downloading ${key} …`)
    await pipeline(await store.open(key.slice('media/'.length)), createWriteStream(inPath))
    const srcBytes = statSync(inPath).size
    const sourceSha = await hashFile(inPath)
    log(`downloaded ${(srcBytes / 1048576).toFixed(1)} MB, source sha256=${sourceSha}`)

    const existing = await db.select().from(schema.media)
      .where(and(eq(schema.media.sourceSha256, sourceSha), eq(schema.media.quality, quality))).get()
    if (existing) {
      log(`already ingested as media id=${existing.id} sha=${existing.sha256} — nothing to do`)
      return
    }

    const probe = await probeVideo(inPath)
    log(`probe: ${probe.codec}/${probe.profile} ${probe.width}x${probe.height} ${probe.pixFmt} ${(probe.durationMs / 1000).toFixed(1)}s audio=${probe.audioCodec}`)

    let finalPath = inPath
    let finalProbe = probe
    if (force || !isKioskSafe(probe)) {
      log(`transcoding → ${quality} (kiosk-safe H.264 Main) …`)
      const r = await ensureQuality(inPath, tmp, quality)
      finalPath = r.path
      finalProbe = r.probe
      log(`transcoded: ${finalProbe.codec}/${finalProbe.profile} ${finalProbe.width}x${finalProbe.height}`)
    } else {
      log('already kiosk-safe — storing as-is')
    }
    const finalSha = await hashFile(finalPath)
    const finalBytes = statSync(finalPath).size

    const dup = await db.select().from(schema.media).where(eq(schema.media.sha256, finalSha)).get()
    if (dup) {
      log(`content already stored as media id=${dup.id} — nothing to do`)
      return
    }

    log(`uploading media/${finalSha} (${(finalBytes / 1048576).toFixed(1)} MB) …`)
    await store.put(finalSha, createReadStream(finalPath), 'video/mp4')

    let thumbnailBytes: number | null = null
    try {
      const thumb = await generateVideoThumbnail(createReadStream(finalPath))
      await store.putThumbnail(finalSha, Readable.from([thumb]))
      thumbnailBytes = thumb.length
      log(`thumbnail stored (${thumb.length} bytes)`)
    } catch (err) {
      log(`thumbnail failed (non-fatal): ${(err as Error).message}`)
    }

    const [row] = await db.insert(schema.media).values({
      sha256: finalSha,
      sourceSha256: sourceSha,
      kind: 'video',
      filename,
      mimeType: 'video/mp4',
      bytes: finalBytes,
      thumbnailBytes,
      durationMs: finalProbe.durationMs,
      width: finalProbe.width,
      height: finalProbe.height,
      quality
    }).returning()
    log(`DONE media id=${row.id} sha=${finalSha} quality=${quality} — source object ${key} left in place`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
