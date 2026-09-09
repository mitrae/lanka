import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { resolvePlaylistForDevice } from '~/server/services/resolver'
import { getInterrupt, nextWindow, type InterruptWindow } from '~/server/services/interrupt'

export type ManifestItem = {
  id: number
  type: 'video' | 'image'
  sha256: string
  durationMs: number
}

export type ManifestInterrupt = {
  mediaId: number
  sha256: string
  durationMs: number
  startsAt: number
  endsAt: number
}

export type Manifest = {
  playlistId: number
  playlistName: string
  version: number
  items: ManifestItem[]
  /** Server build id (runtimeConfig.playerBuild); the web player reloads on a
   *  mismatch with its own bundle. Added by the route handler, not by
   *  handleManifest, so the pure function stays free of runtime config. */
  playerBuild?: string
  /** Server clock at response time. The player derives an offset from it, so a
   *  TV that boots with a wrong system clock still fires at the right moment. */
  serverNow?: number
  /** The next interrupt occurrence that has not yet ended. Absent when none is
   *  configured or it is disabled. */
  interrupt?: ManifestInterrupt
}

export async function handleManifest(
  db: BetterSQLite3Database<typeof schema>,
  deviceId: string,
  nowMs: number = Date.now()
): Promise<Manifest | null> {
  const [device] = await db
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))

  if (!device) {
    throw createError({ statusCode: 404, message: `Unknown device: ${deviceId}` })
  }

  // heartbeat
  await db
    .update(schema.devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.devices.id, deviceId))

  const resolved = await resolvePlaylistForDevice(db, deviceId)
  if (!resolved) return null

  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, resolved.playlistId))

  const items = await db
    .select({
      id: schema.playlistItems.id,
      position: schema.playlistItems.position,
      durationMsOverride: schema.playlistItems.durationMsOverride,
      mediaKind: schema.media.kind,
      mediaSha: schema.media.sha256,
      mediaDur: schema.media.durationMs
    })
    .from(schema.playlistItems)
    .innerJoin(schema.media, eq(schema.media.id, schema.playlistItems.mediaId))
    .where(eq(schema.playlistItems.playlistId, resolved.playlistId))
    .orderBy(asc(schema.playlistItems.position))

  const interruptRow = await getInterrupt(db)
  let interrupt: ManifestInterrupt | undefined
  if (interruptRow?.enabled) {
    const [clip] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, interruptRow.mediaId))
    const durationMs = clip?.durationMs ?? 0
    // One bad row must degrade to "no interrupt", never to a 500: this runs
    // inside every TV's 30 s poll, and a throw here would stop playlist
    // changes, deploy reloads and schedule updates reaching the whole fleet
    // (an unknown timezone makes Intl throw RangeError, for one).
    let w: InterruptWindow | null = null
    try {
      w = clip
        ? nextWindow(nowMs, interruptRow.atMinutes, interruptRow.timezone, durationMs)
        : null
    } catch (err) {
      console.error('[manifest] interrupt window unavailable, publishing none:', err)
    }
    if (clip && w) {
      interrupt = {
        mediaId: clip.id,
        sha256: clip.sha256,
        durationMs,
        startsAt: w.startsAt,
        endsAt: w.endsAt
      }
    }
  }

  return {
    playlistId: pl.id,
    playlistName: pl.name,
    version: pl.version,
    items: items.map((r) => ({
      id: r.id,
      type: r.mediaKind as 'video' | 'image',
      sha256: r.mediaSha,
      durationMs:
        r.mediaKind === 'video' ? (r.mediaDur ?? 0) : (r.durationMsOverride ?? 0)
    })),
    serverNow: nowMs,
    ...(interrupt ? { interrupt } : {})
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })
  const manifest = await handleManifest(useDb(), id)
  if (!manifest) {
    setResponseStatus(event, 204)
    return null
  }
  // A 204 carries no build id, so a box on "no content" learns of a deploy on
  // its next non-null manifest. The native surface ignores the field
  // (kotlinx Json { ignoreUnknownKeys = true }) — it cannot reload code anyway.
  return { ...manifest, playerBuild: useRuntimeConfig().playerBuild as string }
})
