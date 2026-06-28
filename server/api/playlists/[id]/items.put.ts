import { z } from 'zod'
import { eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

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

  // Delete-all + re-insert + version bump must be atomic: a mid-sequence failure
  // (e.g. a concurrent media delete, or two simultaneous reorders racing on the
  // (playlist_id, position) unique index) would otherwise leave the playlist
  // empty and devices polling a blank manifest. better-sqlite3's transaction
  // callback is synchronous, so every op uses .run()/.all() and the version bump
  // is inlined (bumpPlaylistVersion is async and can't run inside it).
  db.transaction((tx) => {
    // Capture the outgoing item ids so we can null any device still pointing at
    // one of them — the replaced rows get fresh autoincrement ids, so a device's
    // current_item_id would otherwise dangle (schema relies on us nulling it).
    const oldItemIds = tx
      .select({ id: schema.playlistItems.id })
      .from(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, playlistId))
      .all()
      .map((r) => r.id)

    tx.delete(schema.playlistItems)
      .where(eq(schema.playlistItems.playlistId, playlistId))
      .run()

    if (oldItemIds.length > 0) {
      tx.update(schema.devices)
        .set({ currentItemId: null })
        .where(inArray(schema.devices.currentItemId, oldItemIds))
        .run()
    }

    if (body.items.length > 0) {
      tx.insert(schema.playlistItems)
        .values(
          body.items.map((it, idx) => ({
            playlistId,
            mediaId: it.mediaId,
            position: idx,
            durationMsOverride: it.durationMsOverride ?? null
          }))
        )
        .run()
    }

    tx.update(schema.playlists)
      .set({
        version: sql`${schema.playlists.version} + 1`,
        updatedAt: new Date()
      })
      .where(eq(schema.playlists.id, playlistId))
      .run()
  })
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
