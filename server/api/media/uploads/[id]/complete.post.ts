import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import { useIngestQueue } from '~/server/services/ingest-queue-singleton'
import type { MediaStore } from '~/server/services/media-store'
import type { IngestQueue } from '~/server/services/media-ingest-queue'
import { isUuid, toUploadJob, type UploadJob } from '~/server/services/media-uploads'

/** The client finished its PUT: verify the staged object and hand the job to the worker. */
export async function handleCompleteUpload(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  queue: Pick<IngestQueue, 'enqueue'>,
  id: string
): Promise<UploadJob> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  // Idempotent for a client whose first /complete response was lost.
  if (row.status === 'queued' || row.status === 'processing' || row.status === 'done') {
    return toUploadJob(row)
  }
  if (row.status !== 'pending') {
    throw createError({ statusCode: 409, message: `Upload is ${row.status}` })
  }

  const staged = await store.statStaged(id)
  if (!staged || staged.bytes !== row.bytes) {
    const message = !staged
      ? 'Uploaded file not found in storage'
      : `Uploaded size ${staged.bytes} does not match declared ${row.bytes}`
    // Conditional too: don't resurrect a row a concurrent cancel just deleted.
    await db
      .update(schema.mediaUploads)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(and(eq(schema.mediaUploads.id, id), eq(schema.mediaUploads.status, 'pending')))
    await store.deleteStaged(id)
    throw createError({ statusCode: 400, message })
  }

  // Atomic transition: only the request that flips pending → queued enqueues.
  const [updated] = await db
    .update(schema.mediaUploads)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(eq(schema.mediaUploads.id, id), eq(schema.mediaUploads.status, 'pending')))
    .returning()
  if (!updated) {
    // Lost the race: re-read and report whatever state won.
    const current = await db
      .select()
      .from(schema.mediaUploads)
      .where(eq(schema.mediaUploads.id, id))
      .get()
    if (!current) throw createError({ statusCode: 404, message: 'Upload not found' })
    if (current.status === 'queued' || current.status === 'processing' || current.status === 'done') {
      return toUploadJob(current)
    }
    throw createError({ statusCode: 409, message: `Upload is ${current.status}` })
  }
  queue.enqueue(id)
  return toUploadJob(updated)
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  return handleCompleteUpload(useDb(), useMediaStore(), useIngestQueue(), id)
})
