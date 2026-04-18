export type EventListener = (event: string, data: unknown) => void

export class EventsHub {
  private deviceListeners = new Map<string, Set<EventListener>>()

  subscribeDevice(deviceId: string, listener: EventListener): () => void {
    let set = this.deviceListeners.get(deviceId)
    if (!set) {
      set = new Set()
      this.deviceListeners.set(deviceId, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.deviceListeners.delete(deviceId)
    }
  }

  emitDevice(deviceId: string, event: string, data: unknown): void {
    const set = this.deviceListeners.get(deviceId)
    if (!set) return
    for (const listener of set) listener(event, data)
  }

  emitAllDevices(event: string, data: unknown): void {
    for (const set of this.deviceListeners.values()) {
      for (const listener of set) listener(event, data)
    }
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.deviceListeners.get(deviceId)?.size ?? 0
  }
}

// Singleton for app use. Tests construct their own.
let _hub: EventsHub | null = null
export function useEventsHub(): EventsHub {
  if (!_hub) _hub = new EventsHub()
  return _hub
}

// Test-only reset
export function _resetEventsHub(): void {
  _hub = null
}
