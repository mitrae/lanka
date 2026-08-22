import { desc, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { ACTIVE_UPLOAD_STATUSES, toUploadJob, type UploadJob } from '~/server/services/media-uploads'

export async function handleListUploads(
  db: BetterSQLite3Database<typeof schema>,
  opts: { active: boolean }
): Promise<UploadJob[]> {
  const base = db.select().from(schema.mediaUploads)
  const rows = opts.active
    ? await base
        .where(inArray(schema.mediaUploads.status, [...ACTIVE_UPLOAD_STATUSES]))
        .orderBy(desc(schema.mediaUploads.createdAt))
    : await base.orderBy(desc(schema.mediaUploads.createdAt)).limit(50)
  return rows.map((r) => toUploadJob(r))
}

export default defineEventHandler((event) => {
  const q = getQuery(event)
  return handleListUploads(useDb(), { active: q.active === '1' || q.active === 'true' })
})
