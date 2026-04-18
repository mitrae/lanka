import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '~/server/db/schema'
import { useDb } from '~/server/db/client'
import { type EventsHub, useEventsHub } from '~/server/services/events'
import { emitManifestChangedToAddress } from '../_emit'

const BodySchema = z.object({ playlistId: z.number().int().positive() })

export async function handleAssignAddress(
  db: BetterSQLite3Database<typeof schema>,
  hub: EventsHub,
  addressId: number,
  rawBody: unknown
) {
  const body = BodySchema.parse(rawBody)
  const [pl] = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, body.playlistId))
  if (!pl) throw createError({ statusCode: 400, message: 'Unknown playlistId' })

  const [addr] = await db
    .select()
    .from(schema.addresses)
    .where(eq(schema.addresses.id, addressId))
  if (!addr) {
    throw createError({ statusCode: 404, message: `Address ${addressId} not found` })
  }

  await db
    .delete(schema.assignments)
    .where(eq(schema.assignments.addressId, addressId))
  const [row] = await db
    .insert(schema.assignments)
    .values({ playlistId: body.playlistId, addressId })
    .returning()

  await emitManifestChangedToAddress(db, hub, addressId)
  return row
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400 })
  const body = await readBody(event)
  try {
    return await handleAssignAddress(useDb(), useEventsHub(), id, body)
  } catch (err: any) {
    if (err.name === 'ZodError') {
      throw createError({ statusCode: 400, message: err.message })
    }
    throw err
  }
})
