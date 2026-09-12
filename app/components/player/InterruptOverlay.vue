<!-- app/components/player/InterruptOverlay.vue -->
<!--
  The scheduled interrupt's clip, rendered ABOVE everything the player is
  otherwise showing — including the standby and no-content screens.

  Two rules from the design that live here:
  - It never decides when to stop. The parent tears it down at the window's
    wall-clock end, so a hung or stalled clip cannot hold a venue's screen.
  - Failure is loud: no decoded frame within STARTUP_BUDGET_MS of an attempt
    and we emit `failed`, the parent resumes the playlist and a device_errors
    row is written. A blank screen is never an acceptable observance — and
    that holds after `started` too: a mid-clip decoder death that the blob
    retry cannot recover gives the screen back instead of sitting black.
  - The direct URL and the blob retry each get their OWN startup budget. One
    shared 5 s timer made the retry dead code whenever the first error landed
    late in the budget — the retry was still fetching when the timer fired.
  - The join offset is read from `offsetNow()` AT SEEK TIME, never snapshotted
    at arming: a screen that took 3 s to reach loadedmetadata joins 3 s further
    in, and a blob retry re-seeks to where the window is now, not to where the
    first attempt joined.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { describeMediaError } from '~/app/composables/player/describeMediaError'
import { fetchBlobUrl } from '~/app/composables/player/fetchBlobUrl'

const props = defineProps<{
  sha256: string
  /** Network URL for the clip (CDN or the /media proxy). */
  src: string
  /** Milliseconds since the window opened, on the corrected clock, as of the
   *  call — so every screen seeks to the same second regardless of how long
   *  its own load took. */
  offsetNow: () => number
}>()

const emit = defineEmits<{
  started: []
  failed: [message: string]
}>()

/** No decoded frame within this much of an attempt (direct URL, then the blob
 *  retry) and we give the screen back to the playlist. */
const STARTUP_BUDGET_MS = 5_000

const video = ref<HTMLVideoElement | null>(null)
let startupTimer: number | null = null
/** The element is producing frames NOW. Cleared on `error` so a blob retry
 *  after a mid-clip death gets a live startup budget of its own. */
let playing = false
/** `started` has been emitted for this window — once, ever. */
let started = false
let failed = false
let blobUrl: string | null = null
let triedBlob = false
/** Set on unmount. The parent tears this component down on the window's
 *  wall-clock end, which can land while a blob retry is still in flight. */
let disposed = false

function clearStartupTimer(): void {
  if (startupTimer !== null) {
    window.clearTimeout(startupTimer)
    startupTimer = null
  }
}

function fail(message: string): void {
  // `failed` is emitted at most once, and never after teardown: a late error
  // from a still-in-flight load would otherwise fire into a parent that has
  // already resumed the playlist. It IS emitted after playback has started —
  // a decoder that dies mid-clip (and whose blob retry also fails) leaves a
  // black overlay that the server has already recorded as observed; the
  // playlist must come back and the failure must be on record.
  if (failed || disposed) return
  failed = true
  clearStartupTimer()
  emit('failed', message)
}

function armStartupBudget(): void {
  clearStartupTimer()
  startupTimer = window.setTimeout(() => {
    startupTimer = null
    if (playing) return
    // A direct-URL load that cannot produce a frame gets the same one blob
    // attempt an `error` would, before it costs the observance.
    if (!triedBlob) {
      void retryViaBlob('interrupt clip never started')
      return
    }
    fail('interrupt clip never started')
  }, STARTUP_BUDGET_MS)
}

function onLoadedMetadata(): void {
  const el = video.value
  if (!el) return
  // Seek before playing: joining in progress is what keeps every screen in the
  // country showing the same second. Read the offset NOW — the arming tick's
  // value is stale by however long this load took.
  const offsetMs = props.offsetNow()
  if (offsetMs > 0) el.currentTime = offsetMs / 1000
  void el.play().catch(() => {
    /* muted autoplay; a real failure surfaces as `error` or the budget */
  })
}

/** One blob attempt, same escape hatch the stage uses for a cached response
 *  the media pipeline refuses. `detail` is what to report if it fails too. */
async function retryViaBlob(detail: string): Promise<void> {
  const el = video.value
  if (!el || triedBlob) {
    fail(detail)
    return
  }
  triedBlob = true
  // The fetch is not on any budget: a hung fetch is ended by the parent at
  // the window's wall-clock end, like everything else here.
  clearStartupTimer()
  try {
    const url = await fetchBlobUrl(props.sha256)
    // The parent may have torn us down at the window's wall-clock end while
    // this fetch was in flight. Re-arming `src` here would put a decoder
    // back on an element onBeforeUnmount deliberately released — on
    // hardware with a handful of decoder instances — and the URL would
    // never be revoked, since the one revoke on the unmount path already
    // ran.
    if (disposed) {
      URL.revokeObjectURL(url)
      return
    }
    blobUrl = url
    el.src = blobUrl
    el.load()
    // A fresh budget for the retry: it is a new load from a new source.
    armStartupBudget()
  } catch (e) {
    fail(`${detail} → blob fetch failed: ${(e as Error).message}`)
  }
}

function onPlaying(): void {
  playing = true
  clearStartupTimer()
  // Any pause/resume of the overlay element re-fires `playing`, and so does
  // a successful blob retry; without this the observance is re-emitted and
  // interruptAt re-posted. Idempotent server-side, but there is no reason to
  // send it twice.
  if (started) return
  started = true
  emit('started')
}

async function onError(): Promise<void> {
  playing = false
  const el = video.value
  const detail = el
    ? describeMediaError(el.error, {
        networkState: el.networkState,
        readyState: el.readyState,
        source: blobUrl ? 'blob' : undefined
      })
    : 'interrupt video decode/load error'

  if (!triedBlob && el) {
    await retryViaBlob(detail)
    return
  }
  fail(detail)
}

onMounted(() => {
  const el = video.value
  if (el) {
    el.src = props.src
    el.load()
  }
  armStartupBudget()
})

onBeforeUnmount(() => {
  disposed = true
  clearStartupTimer()
  const el = video.value
  if (el) {
    el.pause()
    el.removeAttribute('src')
    el.load() // genuinely release the decoder; display:none frees nothing
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl)
})
</script>

<template>
  <div class="interrupt-overlay">
    <video
      ref="video"
      muted
      playsinline
      preload="auto"
      @loadedmetadata="onLoadedMetadata"
      @playing="onPlaying"
      @error="onError"
    />
  </div>
</template>

<style scoped>
.interrupt-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
</style>
