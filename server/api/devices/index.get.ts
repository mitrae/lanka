import { and, asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'

export type DeviceStatus = 'online' | 'idle' | 'offline'

export type DeviceListRow = typeof schema.devices.$inferSelect & {
  status: DeviceStatus
}

function computeStatus(lastSeenAt: Date | null): DeviceStatus {
  if (!lastSeenAt) return 'offline'
  const ageMs = Date.now() - lastSeenAt.getTime()
  if (ageMs <= 60_000) return 'online'
  if (ageMs <= 5 * 60_000) return 'idle'
  return 'offline'
}

export async function handleListDevices(
  db: BetterSQLite3Database<typeof schema>,
  query: { groupId?: number; addressId?: number; unclaimed?: boolean }
): Promise<DeviceListRow[]> {
  const conditions = []

  if (query.unclaimed) {
    conditions.push(sql`${schema.devices.groupId} IS NULL`)
  }
  if (query.groupId !== undefined) {
    conditions.push(eq(schema.devices.groupId, query.groupId))
  }

  let rows: (typeof schema.devices.$inferSelect)[]
  if (query.addressId !== undefined) {
    rows = await db
      .select({
        id: schema.devices.id,
        groupId: schema.devices.groupId,
        name: schema.devices.name,
        lastSeenAt: schema.devices.lastSeenAt,
        playerVersion: schema.devices.playerVersion,
        currentItemId: schema.devices.currentItemId,
        surface: schema.devices.surface,
        visibility: schema.devices.visibility,
        visibilitySince: schema.devices.visibilitySince,
        foregroundPackage: schema.devices.foregroundPackage,
        snapBacks: schema.devices.snapBacks,
        focusLosses: schema.devices.focusLosses,
        hiddenMs: schema.devices.hiddenMs,
        createdAt: schema.devices.createdAt,
        updatedAt: schema.devices.updatedAt
      })
      .from(schema.devices)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.devices.groupId))
      .where(
        and(eq(schema.groups.addressId, query.addressId), ...conditions)
      )
      .orderBy(asc(schema.devices.createdAt))
  } else {
    rows = await db
      .select()
      .from(schema.devices)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(schema.devices.createdAt))
  }

  return rows.map((r) => ({ ...r, status: computeStatus(r.lastSeenAt) }))
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return handleListDevices(useDb(), {
    groupId: q.groupId ? Number(q.groupId) : undefined,
    addressId: q.addressId ? Number(q.addressId) : undefined,
    unclaimed: q.unclaimed === 'true'
  })
})
