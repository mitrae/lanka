// server/services/resolver.ts
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../db/schema'

export type ResolvedPlaylist = {
  playlistId: number
  level: 'device' | 'group' | 'address'
}

export async function resolvePlaylistForDevice(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string
): Promise<ResolvedPlaylist | null> {
  const rows = db.all<{ playlist_id: number; level: string }>(sql`
    SELECT playlist_id, 'device' AS level
      FROM assignments
     WHERE device_id = ${deviceId}
    UNION ALL
    SELECT a.playlist_id, 'group' AS level
      FROM assignments a
      JOIN devices d ON d.group_id = a.group_id
     WHERE d.id = ${deviceId}
    UNION ALL
    SELECT a.playlist_id, 'address' AS level
      FROM assignments a
      JOIN groups g  ON g.address_id = a.address_id
      JOIN devices d ON d.group_id   = g.id
     WHERE d.id = ${deviceId}
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  return {
    playlistId: row.playlist_id,
    level: row.level as ResolvedPlaylist['level']
  }
}
