import type { EventsHub } from '~/server/services/events'
import { useEventsHub } from '~/server/services/events'

export type DeviceEventSource = {
  subscribe: (fn: (event: string, data: unknown) => void) => void
  close: () => void
}

export function createDeviceEventSource(
  hub: EventsHub,
  deviceId: string
): DeviceEventSource {
  let unsubscribe: (() => void) | null = null
  let handler: ((event: string, data: unknown) => void) | null = null

  return {
    subscribe(fn) {
      handler = fn
      unsubscribe = hub.subscribeDevice(deviceId, (event, data) => {
        handler?.(event, data)
      })
    },
    close() {
      unsubscribe?.()
      unsubscribe = null
      handler = null
    }
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing device id' })

  const eventStream = createEventStream(event)
  const src = createDeviceEventSource(useEventsHub(), id)

  src.subscribe((name, data) => {
    void eventStream.push({ event: name, data: JSON.stringify(data ?? null) })
  })

  // keep-alive ping every 20s
  const pingInterval = setInterval(() => {
    void eventStream.push({ event: 'ping', data: '{}' })
  }, 20_000)

  eventStream.onClosed(() => {
    clearInterval(pingInterval)
    src.close()
  })

  return eventStream.send()
})
