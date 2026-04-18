import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import type { MediaStore } from '~/server/services/media-store'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

export { handleGetMedia } from './[id].get'

export async function handleDeleteMedia(
  db: BetterSQLite3Database<typeof schema>,
  store: MediaStore,
  id: number,
  opts: { force: boolean }
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, id))
  if (!row) {
    throw createError({ statusCode: 404, message: `Media ${id} not found` })
  }

  const referencingItems = await db
    .select({
      playlistId: schema.playlistItems.playlistId
    })
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.mediaId, id))

  if (referencingItems.length > 0 && !opts.force) {
    throw createError({
      statusCode: 409,
      message: `Media ${id} is in use by ${referencingItems.length} playlist item(s). Pass force=true to delete anyway.`
    })
  }

  const affectedPlaylists = new Set(referencingItems.map((r) => r.playlistId))

  if (opts.force && affectedPlaylists.size > 0) {
    await db
      .delete(schema.playlistItems)
      .where(eq(schema.playlistItems.mediaId, id))
    for (const pid of affectedPlaylists) {
      await bumpPlaylistVersion(db, pid)
    }
  }

  await db.delete(schema.media).where(eq(schema.media.id, id))
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
