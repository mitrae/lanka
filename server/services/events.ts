export type EventListener = (event: string, data: unknown) => void

export class EventsHub {
  private deviceListeners = new Map<string, Set<EventListener>>()
  private dashboardListeners = new Set<EventListener>()

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

  subscribeDashboard(listener: EventListener): () => void {
    this.dashboardListeners.add(listener)
    return () => {
      this.dashboardListeners.delete(listener)
    }
  }

  emitDevice(deviceId: string, event: string, data: unknown): void {
    const set = this.deviceListeners.get(deviceId)
    if (set) {
      for (const listener of set) listener(event, data)
    }
    // Mirror to dashboard
    for (const listener of this.dashboardListeners) {
      listener('device-event', { deviceId, event, data })
    }
  }

  emitAllDevices(event: string, data: unknown): void {
    for (const set of this.deviceListeners.values()) {
      for (const listener of set) listener(event, data)
    }
  }

  emitDashboard(event: string, data: unknown): void {
    for (const listener of this.dashboardListeners) {
      listener(event, data)
    }
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.deviceListeners.get(deviceId)?.size ?? 0
  }

  dashboardSubscriberCount(): number {
    return this.dashboardListeners.size
  }
}

let _hub: EventsHub | null = null
export function useEventsHub(): EventsHub {
  if (!_hub) _hub = new EventsHub()
  return _hub
}

export function _resetEventsHub(): void {
  _hub = null
}
