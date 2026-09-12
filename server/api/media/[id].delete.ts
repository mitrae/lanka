import { eq, sql, inArray } from 'drizzle-orm'
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
  opts: { force: boolean; clearInterrupt?: boolean }
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

  const interruptRows = await db
    .select({ id: schema.interrupts.id })
    .from(schema.interrupts)
    .where(eq(schema.interrupts.mediaId, id))

  // Its own flag, deliberately NOT `force`: the dashboard escalates to
  // force=true for any clip that is in a playlist, after a confirm that only
  // mentions playlists. Letting that also clear the daily schedule would
  // delete a compliance feature as a side effect of an unrelated dialog.
  if (interruptRows.length > 0 && !opts.clearInterrupt) {
    throw createError({
      statusCode: 409,
      message:
        `Media ${id} is the scheduled interrupt clip. Deleting it would leave a ` +
        `schedule that silently never plays. Pass clearInterrupt=true to delete ` +
        `it and clear the schedule.`
    })
  }

  const affectedPlaylists = new Set(referencingItems.map((r) => r.playlistId))

  db.transaction((tx) => {
    if (opts.force && affectedPlaylists.size > 0) {
      // Null current_item_id on any device playing an item we're about to delete
      // (devices have no FK on it — see schema). Capture ids before the delete.
      const deletedItemIds = tx
        .select({ id: schema.playlistItems.id })
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.mediaId, id))
        .all()
        .map((r) => r.id)

      tx.delete(schema.playlistItems)
        .where(eq(schema.playlistItems.mediaId, id))
        .run()

      if (deletedItemIds.length > 0) {
        tx.update(schema.devices)
          .set({ currentItemId: null })
          .where(inArray(schema.devices.currentItemId, deletedItemIds))
          .run()
      }

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

    if (interruptRows.length > 0) {
      // Same transaction as the media delete: a configured interrupt must never
      // outlive its clip, not even for the width of a failed statement.
      tx.delete(schema.interrupts).where(eq(schema.interrupts.mediaId, id)).run()
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
    force: q.force === 'true',
    clearInterrupt: q.clearInterrupt === 'true'
  })
  setResponseStatus(event, 204)
  return null
})
