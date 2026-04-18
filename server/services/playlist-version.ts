// server/services/playlist-version.ts
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

export async function bumpPlaylistVersion(
  db: BetterSQLite3Database<typeof schema>,
  playlistId: number
): Promise<void> {
  const result = await db
    .update(schema.playlists)
    .set({
      version: sql`${schema.playlists.version} + 1`,
      updatedAt: new Date()
    })
    .where(eq(schema.playlists.id, playlistId))
    .returning({ id: schema.playlists.id })

  if (result.length === 0) {
    throw new Error(`Playlist ${playlistId} not found`)
  }
}
