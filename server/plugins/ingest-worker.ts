// server/plugins/ingest-worker.ts
//
// Boots the async media-ingest worker and keeps it honest:
//  - boot: drop abandoned ingest scratch dirs, expire stale pending uploads,
//    re-queue jobs interrupted by the last restart (recover — boot ONLY: it
//    resets `processing` rows, which would clobber a live transcode if run later);
//  - every 5 min: scratch cleanup + sweep + reconcile (re-enqueue `queued` rows
//    whose in-memory enqueue was lost, e.g. a crash right after /complete).
// Jobs are enqueued live by POST /api/media/uploads/:id/complete.
import { useIngestQueue } from '~/server/services/ingest-queue-singleton'
import { cleanupStaleTmp } from '~/server/services/media-ingest-queue'

const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000

export default defineNitroPlugin(async () => {
  const queue = useIngestQueue()

  async function maintain(label: 'boot' | 'periodic') {
    try {
      const tmp = await cleanupStaleTmp()
      const expired = await queue.sweep()
      if (label === 'boot') await queue.recover()
      else await queue.reconcile()
      if (tmp > 0 || expired > 0) {
        console.log(`[ingest-queue] ${label}: removed ${tmp} stale tmp dir(s), expired ${expired} upload(s)`)
      }
    } catch (err) {
      console.error(`[ingest-queue] ${label} maintenance failed`, err)
    }
  }

  await maintain('boot')
  const timer = setInterval(() => void maintain('periodic'), MAINTENANCE_INTERVAL_MS)
  timer.unref()
})
