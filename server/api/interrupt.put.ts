import { useDb } from '~/server/db/client'
import { useEventsHub } from '~/server/services/events'
import { handlePutInterrupt } from '~/server/services/interrupt'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const db = useDb()
  const status = await handlePutInterrupt(db, body, Date.now())

  // Kick every device so a change lands without waiting out the 30 s poll.
  // The interrupt rides the manifest, so `manifest-changed` is the right event
  // even though no playlist version moved.
  useEventsHub().emitAllDevices('manifest-changed', null)

  return status
})
