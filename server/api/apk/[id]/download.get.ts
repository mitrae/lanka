import { eq } from 'drizzle-orm'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'

export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['super', 'admin'].includes(user.role)) {
    throw createError({ statusCode: 403 })
  }
  const idParam = getRouterParam(event, 'id')
  const id = Number(idParam)
  if (!id) throw createError({ statusCode: 400, message: 'Invalid id' })

  const [row] = await useDb()
    .select()
    .from(schema.apkReleases)
    .where(eq(schema.apkReleases.id, id))
  if (!row) throw createError({ statusCode: 404, message: 'APK release not found' })

  const stream = await useMediaStore().open(row.sha256)
  setHeader(event, 'Content-Type', 'application/vnd.android.package-archive')
  setHeader(event, 'Content-Disposition', `attachment; filename="lanka-${row.version}.apk"`)
  return sendStream(event, stream)
})
