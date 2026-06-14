import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export type MediaDetail = typeof schema.media.$inferSelect & {
  playlists: { id: number; name: string }[]
}

export async function handleGetMedia(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<MediaDetail> {
  const [m] = await db.select().from(schema.media).where(eq(schema.media.id, id))
  if (!m) throw createError({ statusCode: 404, message: 'Media not found' })
  const playlists = await db
    .selectDistinct({ id: schema.playlists.id, name: schema.playlists.name })
    .from(schema.playlistItems)
    .innerJoin(schema.playlists, eq(schema.playlists.id, schema.playlistItems.playlistId))
    .where(eq(schema.playlistItems.mediaId, id))
  return { ...m, playlists }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'Bad media id' })
  return handleGetMedia(useDb(), id)
})
