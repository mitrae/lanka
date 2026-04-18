import { describe, expect, it, vi } from 'vitest'
import { resolveDeviceId } from '~/app/composables/player/resolveDeviceId'

function makeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    get: vi.fn((k: string) => data[k] ?? null),
    set: vi.fn((k: string, v: string) => {
      data[k] = v
    }),
    _data: data
  }
}

describe('resolveDeviceId', () => {
  it('returns the query override without touching storage', () => {
    const storage = makeStorage()
    const id = resolveDeviceId({
      query: 'override-id',
      storage,
      generate: () => 'should-not-call'
    })
    expect(id).toBe('override-id')
    expect(storage.set).not.toHaveBeenCalled()
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('returns storage value when no query override', () => {
    const storage = makeStorage({ 'lanka:deviceId': 'persisted-id' })
    const id = resolveDeviceId({
      query: undefined,
      storage,
      generate: () => 'should-not-call'
    })
    expect(id).toBe('persisted-id')
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('generates and persists when storage is empty', () => {
    const storage = makeStorage()
    const id = resolveDeviceId({
      query: undefined,
      storage,
      generate: () => 'fresh-uuid'
    })
    expect(id).toBe('fresh-uuid')
    expect(storage.set).toHaveBeenCalledWith('lanka:deviceId', 'fresh-uuid')
  })

  it('empty-string query is ignored (treated as absent)', () => {
    const storage = makeStorage({ 'lanka:deviceId': 'persisted-id' })
    const id = resolveDeviceId({
      query: '',
      storage,
      generate: () => 'should-not-call'
    })
    expect(id).toBe('persisted-id')
  })
})
