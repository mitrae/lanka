import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { isUuid } from '~/server/services/media-uploads'

/** Cancel a job that has not been completed yet (the client aborted the PUT). */
export async function handleCancelUpload(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: string
): Promise<void> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  if (row.status !== 'pending') {
    throw createError({ statusCode: 409, message: `Upload is ${row.status}; only pending uploads can be cancelled` })
  }
  // Conditional delete: a concurrent /complete may have moved it on (or a
  // concurrent cancel may have won). Only the request that actually removed
  // the pending row cleans up storage.
  const deleted = await db
    .delete(schema.mediaUploads)
    .where(and(eq(schema.mediaUploads.id, id), eq(schema.mediaUploads.status, 'pending')))
    .returning({ id: schema.mediaUploads.id })
  if (deleted.length === 0) throw createError({ statusCode: 404, message: 'Upload not found' })
  await store.deleteStaged(id)
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  await handleCancelUpload(useDb(), useMediaStore(), id)
  setResponseStatus(event, 204)
  return null
})
