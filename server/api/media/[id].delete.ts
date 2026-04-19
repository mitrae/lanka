import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'

export { handleGetMedia } from './[id].get'

export async function handleDeleteMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: number,
  opts: { force: boolean }
): Promise<void> {
  const existing = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, id))
  const row = existing[0]
  if (!row) {
    throw createError({ statusCode: 404, message: `Media ${id} not found` })
  }

  const referencingItems = await db
    .select({ playlistId: schema.playlistItems.playlistId })
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.mediaId, id))

  if (referencingItems.length > 0 && !opts.force) {
    throw createError({
      statusCode: 409,
      message: `Media ${id} is in use by ${referencingItems.length} playlist item(s). Pass force=true to delete anyway.`
    })
  }

  const affectedPlaylists = new Set(referencingItems.map((r) => r.playlistId))

  db.transaction((tx) => {
    if (opts.force && affectedPlaylists.size > 0) {
      tx.delete(schema.playlistItems)
        .where(eq(schema.playlistItems.mediaId, id))
        .run()
      for (const pid of affectedPlaylists) {
        const bumped = tx
          .update(schema.playlists)
          .set({
            version: sql`${schema.playlists.version} + 1`,
            updatedAt: new Date()
          })
          .where(eq(schema.playlists.id, pid))
          .returning({ id: schema.playlists.id })
          .all()
        if (bumped.length === 0) {
          throw new Error(`Playlist ${pid} not found during force-delete bump`)
        }
      }
    }
    tx.delete(schema.media).where(eq(schema.media.id, id)).run()
  })

  await store.delete(row.sha256)
  await store.deleteThumbnail(row.sha256)
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const q = getQuery(event)
  await handleDeleteMedia(useDb(), useMediaStore(), id, {
    force: q.force === 'true'
  })
  setResponseStatus(event, 204)
  return null
})
