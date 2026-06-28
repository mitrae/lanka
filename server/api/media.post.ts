import { createHash } from 'node:crypto'
import { mkdtempSync, createReadStream, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { eq } from 'drizzle-orm'
import formidable from 'formidable'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { ensureQuality } from '~/server/services/transcode'

export type IngestInput = {
  stream: Readable
  filename: string
  kind: 'video' | 'image'
  mimeType?: string
  durationMs?: number
  width?: number
  height?: number
}

export type IngestedMedia = typeof schema.media.$inferSelect

export async function ingestMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: IngestInput
): Promise<IngestedMedia> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lanka-ingest-'))
  const tmpPath = join(tmpDir, 'in.bin')
  const hash = createHash('sha256')
  let bytes = 0

  try {
    const out = createWriteStream(tmpPath)
    input.stream.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      bytes += chunk.length
    })
    await pipeline(input.stream, out)

    if (bytes === 0) {
      throw createError({ statusCode: 400, message: 'Empty upload' })
    }

    const sourceSha = hash.digest('hex')
    const sourceBytes = bytes

    // 1. Source dedup: if we've already ingested this exact source, return it
    const sourceExisting = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.sourceSha256, sourceSha))
      .get()
    if (sourceExisting) return sourceExisting

    // 2. Determine the final file, mime, sha, and dims by kind
    let finalPath: string
    let finalSha: string
    let finalBytes: number
    let finalMime: string
    let finalWidth: number | null
    let finalHeight: number | null
    let finalDurationMs: number | null

    if (input.kind === 'image') {
      finalPath = tmpPath
      finalSha = sourceSha
      finalBytes = sourceBytes
      finalMime = input.mimeType ?? 'application/octet-stream'
      finalWidth = input.width ?? null
      finalHeight = input.height ?? null
      finalDurationMs = input.durationMs ?? null
    } else {
      // video: run through kiosk-safe normalizer
      let result: Awaited<ReturnType<typeof ensureQuality>>
      try {
        result = await ensureQuality(tmpPath, tmpDir, 'standard')
      } catch {
        throw createError({ statusCode: 422, message: 'Could not process this video' })
      }
      finalPath = result.path
      finalMime = 'video/mp4'
      finalBytes = statSync(finalPath).size
      // Hash the final (possibly transcoded) file
      const outHash = createHash('sha256')
      const { Writable } = await import('node:stream')
      await pipeline(
        createReadStream(finalPath),
        new Writable({
          write(chunk, _enc, cb) {
            outHash.update(chunk)
            cb()
          }
        })
      )
      finalSha = outHash.digest('hex')
      // Probe is authoritative for video dims
      finalWidth = result.probe.width
      finalHeight = result.probe.height
      finalDurationMs = result.probe.durationMs
    }

    // 3. Content dedup: protect against the UNIQUE sha256 constraint
    const contentExisting = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.sha256, finalSha))
      .get()
    if (contentExisting) return contentExisting

    // 4. Store the object
    await store.put(finalSha, createReadStream(finalPath), finalMime)

    // 5. Thumbnail generation — if it fails, log and keep going
    let thumbnailBytes: number | null = null
    try {
      const { generateImageThumbnail, generateVideoThumbnail } = await import(
        '~/server/services/thumbnails'
      )
      const { Readable } = await import('node:stream')
      const thumbBuf =
        input.kind === 'image'
          ? await generateImageThumbnail(createReadStream(finalPath))
          : await generateVideoThumbnail(createReadStream(finalPath))
      await store.putThumbnail(finalSha, Readable.from([thumbBuf]))
      thumbnailBytes = thumbBuf.length
    } catch (err) {
      console.warn('[thumbnail]', { sha256: finalSha, err: (err as Error).message })
    }

    // 6. Insert the media row
    const [row] = await db
      .insert(schema.media)
      .values({
        sha256: finalSha,
        sourceSha256: sourceSha,
        kind: input.kind,
        filename: input.filename,
        mimeType: finalMime,
        bytes: finalBytes,
        thumbnailBytes,
        durationMs: finalDurationMs,
        width: finalWidth,
        height: finalHeight
      })
      .returning()
    return row
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

export default defineEventHandler(async (event) => {
  const form = formidable({ maxFileSize: 500 * 1024 * 1024 }) // 500 MB
  const [fields, files] = await form.parse(event.node.req)

  const file = Array.isArray(files.file) ? files.file[0] : files.file
  if (!file) {
    throw createError({ statusCode: 400, message: 'No "file" field in upload' })
  }
  const kindRaw = Array.isArray(fields.kind) ? fields.kind[0] : fields.kind
  const kind = (kindRaw ?? '') as 'video' | 'image'
  if (kind !== 'video' && kind !== 'image') {
    throw createError({ statusCode: 400, message: 'kind must be "video" or "image"' })
  }

  const durMs = Array.isArray(fields.durationMs)
    ? fields.durationMs[0]
    : fields.durationMs

  const result = await ingestMedia(useDb(), useMediaStore(), {
    stream: createReadStream(file.filepath),
    filename: file.originalFilename ?? 'upload.bin',
    kind,
    mimeType: file.mimetype ?? undefined,
    durationMs: durMs ? Number(durMs) : undefined
  })

  return result
})
