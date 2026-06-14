import { asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export type MediaListRow = typeof schema.media.$inferSelect & {
  usedInPlaylists: number
}

export async function handleListMedia(
  db: BetterSQLite3Database<typeof schema>
): Promise<MediaListRow[]> {
  const rows = await db
    .select({
      id: schema.media.id,
      sha256: schema.media.sha256,
      kind: schema.media.kind,
      filename: schema.media.filename,
      mimeType: schema.media.mimeType,
      bytes: schema.media.bytes,
      thumbnailBytes: schema.media.thumbnailBytes,
      durationMs: schema.media.durationMs,
      width: schema.media.width,
      height: schema.media.height,
      createdAt: schema.media.createdAt,
      organizationId: schema.media.organizationId,
      playCount: schema.media.playCount,
      usedInPlaylists: sql<number>`count(DISTINCT ${schema.playlistItems.playlistId})`
    })
    .from(schema.media)
    .leftJoin(
      schema.playlistItems,
      eq(schema.playlistItems.mediaId, schema.media.id)
    )
    .groupBy(schema.media.id)
    .orderBy(asc(schema.media.createdAt))
  return rows as MediaListRow[]
}

export default defineEventHandler(() => handleListMedia(useDb()))
