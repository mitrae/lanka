// server/api/media/uploads/[id]/file.put.ts
//
// Same-origin transport handed out by LocalDiskStore.createStagedUpload (dev /
// tests / any deployment without R2). Streams the raw request body into the
// store's staging area. With R2 the client PUTs to the presigned URL instead
// and this route is simply never offered.
import { Transform, pipeline, type Readable } from 'node:stream'
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
  // so require exactly the declared byte count end-to-end. Both errors are
  // createError()s (not plain Error) so a size mismatch reaches the client as
  // 400, not an unhandled-shape 500.
  let seen = 0
  const declared = row.bytes
  const exact = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > declared) {
        return cb(createError({ statusCode: 400, message: `Body exceeds declared ${declared} bytes` }))
      }
      cb(null, chunk)
    },
    flush(cb) {
      if (seen !== declared) {
        return cb(createError({ statusCode: 400, message: `Body has ${seen} bytes, declared ${declared}` }))
      }
      cb()
    }
  })
  // `body.pipe(exact)` would NOT forward a source-side error/abort (a real
  // client disconnecting mid-upload) into `exact` — `.pipe()` only forwards
  // data, so `exact` would sit open forever waiting for more input that never
  // arrives, hanging store.putStaged() indefinitely. The callback-style
  // pipeline() below reads from `body` and writes into `exact`, destroying
  // `exact` (and rejecting) the moment `body` errors or aborts. It also
  // attaches its error handling on `exact` synchronously, before
  // LocalDiskStore.putStaged()'s internal `await mkdir(...)` gap, so a
  // same-tick size-mismatch error is never emitted with zero listeners
  // attached (no separate no-op listener needed).
  pipeline(body, exact, () => {})
  try {
    await store.putStaged(id, exact, row.mimeType)
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
