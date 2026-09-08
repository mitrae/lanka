<!-- app/components/player/InterruptOverlay.vue -->
<!--
  The scheduled interrupt's clip, rendered ABOVE everything the player is
  otherwise showing — including the standby and no-content screens.

  Two rules from the design that live here:
  - It never decides when to stop. The parent tears it down at the window's
    wall-clock end, so a hung or stalled clip cannot hold a venue's screen.
  - Failure is loud and immediate: no decoded frame within STARTUP_BUDGET_MS
    and we emit `failed`, the parent resumes the playlist and a device_errors
    row is written. A blank screen is never an acceptable observance.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { describeMediaError } from '~/app/composables/player/describeMediaError'
import { fetchBlobUrl } from '~/app/composables/player/fetchBlobUrl'

const props = defineProps<{
  sha256: string
  /** Network URL for the clip (CDN or the /media proxy). */
  src: string
  /** How far into the clip to start, so every screen stays frame-aligned. */
  startOffsetMs: number
}>()

const emit = defineEmits<{
  started: []
  failed: [message: string]
}>()

/** No decoded frame by then and we give the screen back to the playlist. */
const STARTUP_BUDGET_MS = 5_000

const video = ref<HTMLVideoElement | null>(null)
let startupTimer: number | null = null
let playing = false
let failed = false
let blobUrl: string | null = null
let triedBlob = false

function clearStartupTimer(): void {
  if (startupTimer !== null) {
    window.clearTimeout(startupTimer)
    startupTimer = null
  }
}

function fail(message: string): void {
  // Guards both directions: never after playback has started, and never
  // twice. Without the `failed` half, the startup timer firing first and a
  // late `error` from the same in-flight load arriving after it (e.g. the
  // eventual blob retry also failing) would each pass the `playing` check
  // and double-emit.
  if (playing || failed) return
  failed = true
  clearStartupTimer()
  emit('failed', message)
}

function onLoadedMetadata(): void {
  const el = video.value
  if (!el) return
  // Seek before playing: joining in progress is what keeps every screen in the
  // country showing the same second.
  if (props.startOffsetMs > 0) el.currentTime = props.startOffsetMs / 1000
  void el.play().catch(() => {
    /* muted autoplay; a real failure surfaces as `error` or the budget */
  })
}

function onPlaying(): void {
  playing = true
  clearStartupTimer()
  emit('started')
}

async function onError(): Promise<void> {
  const el = video.value
  const detail = el
    ? describeMediaError(el.error, {
        networkState: el.networkState,
        readyState: el.readyState,
        source: blobUrl ? 'blob' : undefined
      })
    : 'interrupt video decode/load error'

  // One blob attempt, same escape hatch the stage uses for a cached response
  // the media pipeline refuses.
  if (!triedBlob && el) {
    triedBlob = true
    try {
      blobUrl = await fetchBlobUrl(props.sha256)
      el.src = blobUrl
      el.load()
      return
    } catch (e) {
      fail(`${detail} → blob fetch failed: ${(e as Error).message}`)
      return
    }
  }
  fail(detail)
}

onMounted(() => {
  const el = video.value
  if (el) {
    el.src = props.src
    el.load()
  }
  startupTimer = window.setTimeout(() => {
    startupTimer = null
    fail('interrupt clip never started')
  }, STARTUP_BUDGET_MS)
})

onBeforeUnmount(() => {
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
