import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/test-db'
import { seedDevice } from '../helpers/fixtures'
import { EventsHub } from '~/server/services/events'
import { handleReloadDevice } from '~/server/api/devices/[id]/reload.post'

describe('POST /api/devices/:id/reload', () => {
  let db: TestDb
  let close: () => void
  let hub: EventsHub

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    close = t.close
    hub = new EventsHub()
  })
  afterEach(() => close())

  it('emits reload event to the targeted device', async () => {
    await seedDevice(db, { id: 'dev-1' })
    const received: Array<{ event: string; data: unknown }> = []
    hub.subscribeDevice('dev-1', (event, data) => {
      received.push({ event, data })
    })

    await handleReloadDevice(db, hub, 'dev-1')

    expect(received).toEqual([{ event: 'reload', data: null }])
  })

  it('404s on unknown device', async () => {
    await expect(
      handleReloadDevice(db, hub, 'ghost')
    ).rejects.toThrow(/not found/i)
  })
})
