import { createHash } from 'node:crypto'
import { mkdtempSync, createReadStream } from 'node:fs'
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

export type IngestInput = {
  stream: Readable
  filename: string
  kind: 'video' | 'image'
  durationMs?: number
  width?: number
  height?: number
}

export type IngestedMedia = typeof schema.media.$inferSelect

/**
 * Buffers the stream to a temp file to compute sha256 and byte count, then either:
 * - returns the existing media row if sha256 already present (dedupe), OR
 * - moves the file into the store and inserts a new media row.
 */
export async function ingestMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: IngestInput
): Promise<IngestedMedia> {
  // Tee to temp file while hashing
  const tmpDir = mkdtempSync(join(tmpdir(), 'lanka-ingest-'))
  const tmpPath = join(tmpDir, 'upload.bin')
  const hash = createHash('sha256')
  let bytes = 0

  const out = createWriteStream(tmpPath)
  input.stream.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    bytes += chunk.length
  })
  await pipeline(input.stream, out)

  if (bytes === 0) {
    await rm(tmpDir, { recursive: true, force: true })
    throw createError({ statusCode: 400, message: 'Empty upload' })
  }

  const sha256 = hash.digest('hex')

  const existing = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.sha256, sha256))
    .get()

  if (existing) {
    await rm(tmpDir, { recursive: true, force: true })
    return existing
  }

  await store.put(sha256, createReadStream(tmpPath))
  await rm(tmpDir, { recursive: true, force: true })

  const [row] = await db
    .insert(schema.media)
    .values({
      sha256,
      kind: input.kind,
      filename: input.filename,
      bytes,
      durationMs: input.durationMs ?? null,
      width: input.width ?? null,
      height: input.height ?? null
    })
    .returning()
  return row
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
    durationMs: durMs ? Number(durMs) : undefined
  })

  return result
})
