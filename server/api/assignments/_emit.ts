import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { EventsHub } from '~/server/services/events'
import * as schema from '~/server/db/schema'

export async function emitManifestChangedToDevice(
  hub: EventsHub,
  deviceId: string
) {
  hub.emitDevice(deviceId, 'manifest-changed', null)
}

export async function emitManifestChangedToGroup(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  groupId: number
) {
  const devices = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.groupId, groupId))
  for (const d of devices) {
    hub.emitDevice(d.id, 'manifest-changed', null)
  }
}

export async function emitManifestChangedToAddress(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  addressId: number
) {
  const groups = await db
    .select({ id: schema.groups.id })
    .from(schema.groups)
    .where(eq(schema.groups.addressId, addressId))
  if (groups.length === 0) return
  const devices = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      inArray(
        schema.devices.groupId,
        groups.map((g) => g.id)
      )
    )
  for (const d of devices) {
    hub.emitDevice(d.id, 'manifest-changed', null)
  }
}
