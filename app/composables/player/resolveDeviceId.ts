export interface DeviceIdStorage {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface ResolveDeviceIdDeps {
  query: string | undefined
  storage: DeviceIdStorage
  generate: () => string
}

export const DEVICE_ID_KEY = 'lanka:deviceId'

export function resolveDeviceId(deps: ResolveDeviceIdDeps): string {
  if (deps.query && deps.query.length > 0) {
    return deps.query
  }
  const fromStorage = deps.storage.get(DEVICE_ID_KEY)
  if (fromStorage) return fromStorage

  const fresh = deps.generate()
  deps.storage.set(DEVICE_ID_KEY, fresh)
  return fresh
}
