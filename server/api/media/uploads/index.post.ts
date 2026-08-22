import { randomUUID } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore, StagedUploadTicket } from '~/server/services/media-store'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  HARD_MAX_UPLOAD_BYTES,
  parseKind,
  parseQuality,
  toUploadJob,
  type UploadJob
} from '~/server/services/media-uploads'

export interface CreateUploadInput {
  filename?: unknown
  kind?: unknown
  quality?: unknown
  mimeType?: unknown
  bytes?: unknown
}

export type CreatedUpload = UploadJob & { upload: StagedUploadTicket }

export async function handleCreateUpload(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  input: CreateUploadInput,
  opts: { maxBytes: number }
): Promise<CreatedUpload> {
  const kind = parseKind(input.kind)
  const quality = parseQuality(input.quality)

  // 255 code points (slice() would cut UTF-16 surrogate pairs in half).
  const filename =
    typeof input.filename === 'string' ? Array.from(input.filename.trim()).slice(0, 255).join('') : ''
  if (!filename) throw createError({ statusCode: 400, message: 'filename is required' })

  // Browser-supplied hint only (ffprobe decides for video). Browsers report an
  // empty type for unknown extensions (.mkv, .ts), so allow octet-stream.
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : ''
  if (!mimeType.startsWith(`${kind}/`) && mimeType !== 'application/octet-stream') {
    throw createError({ statusCode: 400, message: `mimeType must be ${kind}/* or application/octet-stream` })
  }

  const bytes = input.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
    throw createError({ statusCode: 400, message: 'bytes must be a positive integer' })
  }
  if (bytes > opts.maxBytes) {
    throw createError({
      statusCode: 413,
      message: `File exceeds the ${Math.floor(opts.maxBytes / 1024 ** 2)} MB upload limit`
    })
  }

  // Presign first: if the store/SDK fails there is no orphaned `pending` row.
  const id = randomUUID()
  const upload = await store.createStagedUpload(id, { contentType: mimeType, bytes })
  const [row] = await db
    .insert(schema.mediaUploads)
    .values({ id, filename, kind, quality, mimeType, bytes, status: 'pending' })
    .returning()
  return { ...toUploadJob(row), upload }
}

/** runtimeConfig.maxUploadBytes, defaulted and clamped to the single-PUT limit. */
export function maxUploadBytesFromConfig(): number {
  const raw = Number((useRuntimeConfig() as any).maxUploadBytes)
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES
  return Math.min(value, HARD_MAX_UPLOAD_BYTES)
}

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) ?? {}
  const result = await handleCreateUpload(useDb(), useMediaStore(), body, {
    maxBytes: maxUploadBytesFromConfig()
  })
  setResponseStatus(event, 201)
  return result
})
