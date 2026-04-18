import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export { handleGetPlaylist } from './[id].get'
export { handleUpdatePlaylist } from './[id].patch'

export async function handleDeletePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number
): Promise<void> {
  const result = await db
    .delete(schema.playlists)
    .where(eq(schema.playlists.id, id))
    .returning({ id: schema.playlists.id })
  if (result.length === 0) {
    throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
  }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  await handleDeletePlaylist(useDb(), id)
  setResponseStatus(event, 204)
  return null
})
