import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { resolvePlaylistForDevice } from './resolver'

const ONLINE_WINDOW_MS = 5 * 60 * 1000

export type MediaReach = {
  mediaId: number
  filename: string
  kind: 'video' | 'image'
  screensScheduled: number
  screensOnline: number
  screensShowingNow: number
  recentErrors: number
}
export type OrgReach = {
  organization: { id: number; name: string }
  totals: { mediaCount: number; screensReached: number; screensOnline: number; showingNow: number }
  media: MediaReach[]
}

export async function computeOrgReach(
  db: BetterSQLite3Database<typeof schema>,
  organizationId: number,
  now = new Date()
): Promise<OrgReach | null> {
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
  if (!org) return null

  const orgMedia = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.organizationId, organizationId))
  const orgMediaIds = new Set(orgMedia.map((m) => m.id))

  const acc = new Map<number, { scheduled: Set<string>; online: Set<string>; now: Set<string> }>()
  for (const m of orgMedia) acc.set(m.id, { scheduled: new Set(), online: new Set(), now: new Set() })

  const devices = await db.select().from(schema.devices)
  const playlistMedia = new Map<number, number[]>()
  const itemToMedia = new Map<number, number>()

  for (const dev of devices) {
    const resolved = await resolvePlaylistForDevice(db, dev.id)
    if (!resolved) continue
    if (!playlistMedia.has(resolved.playlistId)) {
      const items = await db
        .select({ id: schema.playlistItems.id, mediaId: schema.playlistItems.mediaId })
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.playlistId, resolved.playlistId))
      playlistMedia.set(resolved.playlistId, items.map((i) => i.mediaId))
      for (const i of items) itemToMedia.set(i.id, i.mediaId)
    }
    const online = !!dev.lastSeenAt && now.getTime() - dev.lastSeenAt.getTime() <= ONLINE_WINDOW_MS
    const nowMediaId = dev.currentItemId != null ? itemToMedia.get(dev.currentItemId) : undefined
    for (const mid of playlistMedia.get(resolved.playlistId)!) {
      if (!orgMediaIds.has(mid)) continue
      const a = acc.get(mid)!
      a.scheduled.add(dev.id)
      if (online) a.online.add(dev.id)
      if (nowMediaId === mid) a.now.add(dev.id)
    }
  }

  const shaToMedia = new Map(orgMedia.map((m) => [m.sha256, m.id]))
  const errorCounts = new Map<number, number>()
  if (orgMedia.length > 0) {
    const errs = await db
      .select({ sha256: schema.deviceErrors.sha256 })
      .from(schema.deviceErrors)
      .where(inArray(schema.deviceErrors.sha256, orgMedia.map((m) => m.sha256)))
    for (const e of errs) {
      const mid = e.sha256 ? shaToMedia.get(e.sha256) : undefined
      if (mid != null) errorCounts.set(mid, (errorCounts.get(mid) ?? 0) + 1)
    }
  }

  const media: MediaReach[] = orgMedia.map((m) => {
    const a = acc.get(m.id)!
    return {
      mediaId: m.id,
      filename: m.filename,
      kind: m.kind as 'video' | 'image',
      screensScheduled: a.scheduled.size,
      screensOnline: a.online.size,
      screensShowingNow: a.now.size,
      recentErrors: errorCounts.get(m.id) ?? 0
    }
  })

  const reached = new Set<string>()
  const onlineAll = new Set<string>()
  const nowAll = new Set<string>()
  for (const a of acc.values()) {
    a.scheduled.forEach((d) => reached.add(d))
    a.online.forEach((d) => onlineAll.add(d))
    a.now.forEach((d) => nowAll.add(d))
  }

  return {
    organization: { id: org.id, name: org.name },
    totals: { mediaCount: orgMedia.length, screensReached: reached.size, screensOnline: onlineAll.size, showingNow: nowAll.size },
    media
  }
}
