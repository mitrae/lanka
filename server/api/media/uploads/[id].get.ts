import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { isUuid, toUploadJob, type UploadJob } from '~/server/services/media-uploads'

export async function handleGetUpload(
  db: BetterSQLite3Database<typeof schema>,
  id: string
): Promise<UploadJob> {
  if (!isUuid(id)) throw createError({ statusCode: 404, message: 'Upload not found' })
  const row = await db
    .select()
    .from(schema.mediaUploads)
    .where(eq(schema.mediaUploads.id, id))
    .get()
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  let media = null
  if (row.status === 'done' && row.mediaId != null) {
    media =
      (await db.select().from(schema.media).where(eq(schema.media.id, row.mediaId)).get()) ?? null
  }
  return toUploadJob(row, media)
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  return handleGetUpload(useDb(), id)
})
