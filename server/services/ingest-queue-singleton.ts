import { useDb } from '~/server/db/client'
import { useMediaStore } from './media-store-singleton'
import { createIngestQueue, type IngestQueue } from './media-ingest-queue'

let _queue: IngestQueue | null = null

export function useIngestQueue(): IngestQueue {
  if (!_queue) _queue = createIngestQueue({ db: useDb(), store: useMediaStore() })
  return _queue
}

export function _setIngestQueue(queue: IngestQueue | null): void {
  _queue = queue
}
