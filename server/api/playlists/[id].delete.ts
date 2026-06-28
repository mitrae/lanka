import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetPlaylist } from './[id].get'
export { handleUpdatePlaylist } from './[id].patch'

export async function handleDeletePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  // Deleting the playlist cascade-deletes its items (FK), but devices have no FK
  // on current_item_id, so any device playing one of those items would be left
  // pointing at a dead id. Capture the item ids and null them in the same
  // transaction (a throw rolls the whole thing back).
  db.transaction((tx) => {
    const itemIds = tx
      .select({ id: schema.playlistItems.id })
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, id))
      .all()
      .map((r) => r.id)

    const result = tx
      .delete(schema.playlists)
      .where(eq(schema.playlists.id, id))
      .returning({ id: schema.playlists.id })
      .all()
    if (result.length === 0) {
      throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
    }

    if (itemIds.length > 0) {
      tx.update(schema.devices)
        .set({ currentItemId: null })
        .where(inArray(schema.devices.currentItemId, itemIds))
        .run()
    }
  })
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeletePlaylist(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
