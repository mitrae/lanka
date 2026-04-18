import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

const CreateSchema = z.object({ name: z.string().min(1).max(200) })

export async function handleCreatePlaylist(
  db: BetterSQLite3Database<typeof schema>,
  rawBody: unknown
) {
  const body = CreateSchema.parse(rawBody)
  const [row] = await db
    .insert(schema.playlists)
    .values({ name: body.name })
    .returning()
  return row
}

export { handleListPlaylists } from './index.get'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await handleCreatePlaylist(useDb(), body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
