// server/services/assignments.ts
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

export type AssignmentLevel = 'device' | 'group' | 'address'

export type AssignmentTarget =
  | { level: 'device'; id: string }
  | { level: 'group'; id: number }
  | { level: 'address'; id: number }

/** The playlist assignment stored *at this exact level* — nothing inherited. */
export type DirectAssignment = { playlistId: number; playlistName: string }

/**
 * What a detail endpoint reports about one node of the
 * Address → Group → Device hierarchy: the row the assignment picker edits
 * (`direct*`) and the playlist that actually wins for it (`effective*`).
 */
export type AssignmentContext = {
  directPlaylistId: number | null
  directPlaylistName: string | null
  effectivePlaylistId: number | null
  effectivePlaylistName: string | null
  effectiveLevel: AssignmentLevel | null
}

export async function findDirectAssignment(
  db: BetterSQLite3Database<typeof schema>,
  target: AssignmentTarget
): Promise<DirectAssignment | null> {
  const where =
    target.level === 'device'
      ? eq(schema.assignments.deviceId, target.id)
      : target.level === 'group'
        ? eq(schema.assignments.groupId, target.id)
        : eq(schema.assignments.addressId, target.id)

  const [row] = await db
    .select({
      playlistId: schema.playlists.id,
      playlistName: schema.playlists.name
    })
    .from(schema.assignments)
    .innerJoin(
      schema.playlists,
      eq(schema.playlists.id, schema.assignments.playlistId)
    )
    .where(where)
  return row ?? null
}

export function directOnly(
  direct: DirectAssignment | null,
  level: AssignmentLevel
): AssignmentContext {
  return {
    directPlaylistId: direct?.playlistId ?? null,
    directPlaylistName: direct?.playlistName ?? null,
    effectivePlaylistId: direct?.playlistId ?? null,
    effectivePlaylistName: direct?.playlistName ?? null,
    effectiveLevel: direct ? level : null
  }
}

export function withInherited(
  direct: DirectAssignment | null,
  level: AssignmentLevel,
  inherited: { assignment: DirectAssignment | null; level: AssignmentLevel }
): AssignmentContext {
  if (direct) return directOnly(direct, level)
  return {
    directPlaylistId: null,
    directPlaylistName: null,
    effectivePlaylistId: inherited.assignment?.playlistId ?? null,
    effectivePlaylistName: inherited.assignment?.playlistName ?? null,
    effectiveLevel: inherited.assignment ? inherited.level : null
  }
}
