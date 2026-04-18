import { asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export async function handleListPlaylists(
  db: BetterSQLite3Database<typeof schema>
) {
  const withItems = await db
    .select({
      id: schema.playlists.id,
      name: schema.playlists.name,
      version: schema.playlists.version,
      createdAt: schema.playlists.createdAt,
      updatedAt: schema.playlists.updatedAt,
      itemCount: sql<number>`count(${schema.playlistItems.id})`
    })
    .from(schema.playlists)
    .leftJoin(
      schema.playlistItems,
      eq(schema.playlistItems.playlistId, schema.playlists.id)
    )
    .groupBy(schema.playlists.id)
    .orderBy(asc(schema.playlists.createdAt))

  const assignmentCounts = await db
    .select({
      playlistId: schema.assignments.playlistId,
      c: sql<number>`count(${schema.assignments.id})`
    })
    .from(schema.assignments)
    .groupBy(schema.assignments.playlistId)

  const aMap = new Map(assignmentCounts.map((r) => [r.playlistId, r.c]))
  return withItems.map((r) => ({
    ...r,
    assignmentCount: aMap.get(r.id) ?? 0
  }))
}

export default defineEventHandler(() => handleListPlaylists(useDb()))
