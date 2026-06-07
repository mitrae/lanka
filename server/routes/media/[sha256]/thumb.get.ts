import { eq } from 'drizzle-orm'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import * as schema from '~/server/db/schema'

export default defineEventHandler(async (event) => {
  const sha = getRouterParam(event, 'sha256')
  if (!sha) throw createError({ statusCode: 400 })

  const [row] = await useDb()
    .select()
    .from(schema.media)
    .where(eq(schema.media.sha256, sha))
  if (!row) throw createError({ statusCode: 404 })

  const store = useMediaStore()
  if (!(await store.hasThumbnail(sha))) {
    throw createError({ statusCode: 404, message: 'No thumbnail available' })
  }

  setResponseHeader(event, 'Content-Type', 'image/jpeg')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  return sendStream(event, await store.openThumbnail(sha))
})
