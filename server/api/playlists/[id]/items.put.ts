import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { bumpPlaylistVersion } from '~/server/services/playlist-version'

const BodySchema = z.object({
  items: z.array(
    z.object({
      mediaId: z.number().int().positive(),
      durationMsOverride: z.number().int().positive().optional()
    })
  )
})

export async function handleReplacePlaylistItems(
  db: BetterSQLite3Database<typeof schema>,
  playlistId: number,
  rawBody: unknown
): Promise<void> {
  const body = BodySchema.parse(rawBody)

  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, playlistId))
  if (!pl) {
    throw createError({
      statusCode: 404,
      message: `Playlist ${playlistId} not found`
    })
  }

  if (body.items.length > 0) {
    const mediaIds = body.items.map((i) => i.mediaId)
    const existingMedia = await db
      .select({ id: schema.media.id, kind: schema.media.kind })
      .from(schema.media)
      .where(inArray(schema.media.id, mediaIds))

    if (existingMedia.length !== new Set(mediaIds).size) {
      throw createError({
        statusCode: 400,
        message: 'One or more media items not found'
      })
    }

    const mediaKind = new Map(existingMedia.map((m) => [m.id, m.kind]))
    for (const it of body.items) {
      if (
        mediaKind.get(it.mediaId) === 'image' &&
        it.durationMsOverride === undefined
      ) {
        throw createError({
          statusCode: 400,
          message: `Image items require durationMsOverride (mediaId=${it.mediaId})`
        })
      }
    }
  }

  await db
    .delete(schema.playlistItems)
    .where(eq(schema.playlistItems.playlistId, playlistId))

  if (body.items.length > 0) {
    await db.insert(schema.playlistItems).values(
      body.items.map((it, idx) => ({
        playlistId,
        mediaId: it.mediaId,
        position: idx,
        durationMsOverride: it.durationMsOverride ?? null
      }))
    )
  }

  await bumpPlaylistVersion(db, playlistId)
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    await handleReplacePlaylistItems(useDb(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
  setResponseStatus(event, 204)
  return null
})
