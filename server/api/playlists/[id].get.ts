import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleGetPlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number
) {
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, id))
  if (!pl) {
    throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
  }
  const items = await db
    .select()
    .from(schema.playlistItems)
    .where(eq(schema.playlistItems.playlistId, id))
    .orderBy(asc(schema.playlistItems.position))
  return { ...pl, items }
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  return handleGetPlaylist(useDb(), id)
})
