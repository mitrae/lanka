import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

const UpdateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleUpdatePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  id: number,
  rawBody: unknown
) {
  const body = UpdateSchema.parse(rawBody)
  const [row] = await db
    .update(schema.playlists)
    .set({ name: body.name, updatedAt: new Date() })
    .where(eq(schema.playlists.id, id))
    .returning()
  if (!row) {
    throw createError({ statusCode: 404, message: `Playlist ${id} not found` })
  }
  await bumpPlaylistVersion(db, id)
  const [refetched] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, id))
  return refetched
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleUpdatePlaylist(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
