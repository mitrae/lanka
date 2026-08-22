// server/api/media/uploads/[id]/file.put.ts
//
// Same-origin transport handed out by LocalDiskStore.createStagedUpload (dev /
// tests / any deployment without R2). Streams the raw request body into the
// store's staging area. With R2 the client PUTs to the presigned URL instead
// and this route is simply never offered.
import { Transform, type Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { isUuid } from '~/server/services/media-uploads'
import { maxUploadBytesFromConfig } from '../index.post'

export async function handleReceiveUploadFile(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: string,
  body: Readable,
  contentLength: number | null,
  opts: { maxBytes: number }
): Promise<void> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  if (row.status !== 'pending') {
    throw createError({ statusCode: 409, message: `Upload is already ${row.status}` })
  }
  if (contentLength == null || !Number.isInteger(contentLength) || contentLength !== row.bytes) {
    throw createError({ statusCode: 400, message: 'content-length must equal the declared bytes' })
  }
  if (contentLength > opts.maxBytes) {
    throw createError({ statusCode: 413, message: 'File exceeds the upload limit' })
  }

  // Belt and braces: content-length can lie and a client can disconnect early,
  // so require exactly the declared byte count end-to-end.
  let seen = 0
  const declared = row.bytes
  const exact = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > declared) return cb(new Error(`Body exceeds declared ${declared} bytes`))
      cb(null, chunk)
    },
    flush(cb) {
      if (seen !== declared) return cb(new Error(`Body has ${seen} bytes, declared ${declared}`))
      cb()
    }
  })
  // LocalDiskStore.putStaged() awaits an mkdir() before it ever calls
  // pipeline(exact, ...) — during that gap `body`'s already-flowing data can
  // make `exact` emit 'error' with no listener attached yet, which is an
  // unhandled-exception crash in Node regardless of the try/catch below (only
  // an attached listener suppresses it; same gotcha documented in
  // media-ingest-queue.ts). Attach a no-op listener up front so the real
  // rejection below is the only thing that surfaces.
  exact.on('error', () => {})
  try {
    await store.putStaged(id, body.pipe(exact), row.mimeType)
  } catch (err) {
    await store.deleteStaged(id).catch(() => {})
    throw err
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const lenHeader = getRequestHeader(event, 'content-length')
  const contentLength = lenHeader ? Number(lenHeader) : null
  await handleReceiveUploadFile(useDb(), useMediaStore(), id, event.node.req, contentLength, {
    maxBytes: maxUploadBytesFromConfig()
  })
  setResponseStatus(event, 204)
  return null
})
