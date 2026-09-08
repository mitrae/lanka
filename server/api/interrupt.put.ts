import { useDb } from '~/server/db/client'
import * as schema from '~/server/db/schema'
import { useEventsHub } from '~/server/services/events'
import { handlePutInterrupt } from '~/server/services/interrupt'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const db = useDb()
  const status = await handlePutInterrupt(db, body, Date.now())

  // Kick every device so a change lands without waiting out the 30 s poll.
  // The interrupt rides the manifest, so `manifest-changed` is the right event
  // even though no playlist version moved.
  const hub = useEventsHub()
  const devices = await db.select({ id: schema.devices.id }).from(schema.devices)
  for (const d of devices) hub.emitDevice(d.id, 'manifest-changed', null)

  return status
})
