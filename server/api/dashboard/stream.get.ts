import type { EventsHub } from '~/server/services/events'
import { useEventsHub } from '~/server/services/events'

export type DashboardEventSource = {
  subscribe: (fn: (event: string, data: unknown) => void) => void
  close: () => void
}

export function createDashboardEventSource(hub: EventsHub): DashboardEventSource {
  let unsubscribe: (() => void) | null = null
  return {
    subscribe(fn) {
      unsubscribe = hub.subscribeDashboard(fn)
    },
    close() {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}

export default defineEventHandler(async (event) => {
  const eventStream = createEventStream(event)
  const src = createDashboardEventSource(useEventsHub())

  src.subscribe((name, data) => {
    void eventStream.push({ event: name, data: JSON.stringify(data ?? null) })
  })

  const pingInterval = setInterval(() => {
    void eventStream.push({ event: 'ping', data: '{}' })
  }, 20_000)

  eventStream.onClosed(() => {
    clearInterval(pingInterval)
    src.close()
  })

  return eventStream.send()
})
