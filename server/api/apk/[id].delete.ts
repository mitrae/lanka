import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MediaStore } from '~/server/services/media-store'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

export async function handleDeleteApkRelease(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: number
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.apkReleases)
    .where(eq(schema.apkReleases.id, id))
  if (!row) throw createError({ statusCode: 404, message: 'APK release not found' })
  await db.delete(schema.apkReleases).where(eq(schema.apkReleases.id, id))
  await store.delete(row.sha256)
}

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const idParam = getRouterParam(event, 'id')
  const id = Number(idParam)
  if (!id) throw createError({ statusCode: 400, message: 'Invalid id' })
  await handleDeleteApkRelease(useDb(), useMediaStore(), id)
  setResponseStatus(event, 204)
  return null
})
