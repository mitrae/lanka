import { desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListApkReleases(db: BetterSQLite3Database<typeof schema>) {
  return db
    .select()
    .from(schema.apkReleases)
    .orderBy(desc(schema.apkReleases.uploadedAt), desc(schema.apkReleases.id))
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  return handleListApkReleases(useDb())
})
