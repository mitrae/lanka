<!-- app/components/player/PlayerStage.vue -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Manifest, ManifestItem } from '~/app/types/api'
import type { SchedulerHandle } from '~/app/composables/player/createPlayerScheduler'
import type { PlayerEnv } from '~/app/composables/player/usePlayerEnv'
import { createStallWatchdog } from '~/app/composables/player/createStallWatchdog'

const props = defineProps<{
  manifest: Manifest
  scheduler: SchedulerHandle
  env: PlayerEnv
}>()

// Slot A/B swap. When `frontIsA` is true, slot A is front (visible), B is back (preloading).
const frontIsA = ref(true)

// Refs to the four media elements. Each slot always has both <video> and <img>;
// `display` is toggled per the item type rather than unmounting.
const videoA = ref<HTMLVideoElement | null>(null)
const imgA = ref<HTMLImageElement | null>(null)
const videoB = ref<HTMLVideoElement | null>(null)
const imgB = ref<HTMLImageElement | null>(null)

// Track which item each slot currently holds (for display-type toggling).
const itemInA = ref<ManifestItem | null>(null)
const itemInB = ref<ManifestItem | null>(null)

// Consecutive error count — fall into a "stalled" state if we can't make
// progress, then self-heal by retrying after a delay (no operator needed).
const MAX_CONSECUTIVE_ERRORS = 5
const RECOVERY_DELAY_MS = 15_000
let consecutiveErrors = 0
const stalled = ref(false)
let recoveryTimer: number | null = null

// Freeze detection. A <video> that dies mid-clip — decoder underrun on the
// kiosk box, a hung byte range — fires `waiting`/`stalled`, NOT `error`, so
// `@error`/`@ended` alone leave the frame stuck with no event to act on. We
// poll currentTime instead and treat "media time frozen while playback was
// expected" as an error, which feeds the same reporting + retry path.
const STALL_SAMPLE_MS = 2000
const STALL_THRESHOLD_MS = 8000
const watchdog = createStallWatchdog(STALL_THRESHOLD_MS)
let stallTimer: number | null = null
let lastSeenTime = -1

function clearRecoveryTimer(): void {
  if (recoveryTimer !== null) {
    window.clearTimeout(recoveryTimer)
    recoveryTimer = null
  }
}

function scheduleRecovery(): void {
  if (recoveryTimer !== null) return
  recoveryTimer = window.setTimeout(() => {
    recoveryTimer = null
    // Retry the current items. If media/network has recovered the stall clears
    // and playback resumes; if not, errors climb back to the threshold and we
    // re-arm — a slow self-healing retry instead of a permanently dark screen.
    consecutiveErrors = 0
    stalled.value = false
    mountInitial()
  }, RECOVERY_DELAY_MS)
}

/** Forget any in-flight stall window — after a retry, a slot swap or a
 *  remount the element starts from a clean slate. */
function resetProgressTracking(): void {
  watchdog.reset()
  lastSeenTime = -1
}

function frontSlot(): 'A' | 'B' {
  return frontIsA.value ? 'A' : 'B'
}
function backSlot(): 'A' | 'B' {
  return frontIsA.value ? 'B' : 'A'
}

function elementsFor(slot: 'A' | 'B'): {
  video: HTMLVideoElement | null
  img: HTMLImageElement | null
} {
  return slot === 'A'
    ? { video: videoA.value, img: imgA.value }
    : { video: videoB.value, img: imgB.value }
}

function setItemInSlot(slot: 'A' | 'B', item: ManifestItem | null): void {
  const { video, img } = elementsFor(slot)
  if (slot === 'A') itemInA.value = item
  else itemInB.value = item

  if (!item || !video || !img) return

  const url = props.env.fileUrl(item.sha256)
  if (item.type === 'video') {
    video.src = url
    video.load()
  } else {
    img.src = url
  }
}

function frontItem(): ManifestItem | null {
  return frontIsA.value ? itemInA.value : itemInB.value
}

function playFrontVideoIfNeeded(): void {
  const item = frontItem()
  if (!item || item.type !== 'video') return
  const { video } = elementsFor(frontSlot())
  if (!video) return
  // Single-video mode: let the native loop attribute handle continuous play.
  video.loop = props.scheduler.mode === 'single-video'
  void video.play().catch(() => {
    /* autoplay is muted; failures are swallowed and reported on error */
  })
}

/** Re-mount the current front item in place: re-assign src, reload, play.
 *  The only recovery available when there is nothing to advance to. */
function retryFrontItem(): void {
  const item = frontItem()
  if (!item) return
  if (item.type === 'image') {
    // Re-assigning an identical src is a no-op for <img> — the browser won't
    // refetch, and no fresh load/error fires — so the retry has to change it.
    // (<video> always re-runs its load algorithm, and we call load() anyway.)
    const { img } = elementsFor(frontSlot())
    if (img) img.removeAttribute('src')
  }
  setItemInSlot(frontSlot(), item)
  playFrontVideoIfNeeded()
  resetProgressTracking()
}

function reportError(index: number, msg: string): void {
  consecutiveErrors += 1
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    // Pause error-driven advancing and retry after a delay. Do NOT call
    // scheduler.stop() — that permanently clears its handlers, so the screen
    // could only ever recover via a manifest change (operator action).
    stalled.value = true
    scheduleRecovery()
    return
  }
  props.scheduler.itemErrored(index, msg)
  // A single-item playlist has nowhere to advance to: the scheduler records the
  // error and returns. Without this retry the frame stays frozen until an
  // operator bumps the playlist version — which is exactly how a prod TV sat on
  // one still frame for hours (2026-09).
  if (!props.scheduler.advancesOnError) retryFrontItem()
}

/** Poll the front video for frozen media time; report a stall as an error so it
 *  gets a device_errors row and the same retry/backoff treatment. */
function sampleProgress(): void {
  if (stalled.value) return // the recovery timer owns retries in this state
  const item = frontItem()
  const { video } = elementsFor(frontSlot())
  if (!item || item.type !== 'video' || !video) {
    resetProgressTracking()
    return
  }
  // `paused` is deliberately NOT part of this: a front video that ended up
  // paused (rejected play(), dead decoder) is itself a fault we want to retry.
  const expectPlaying = !!video.currentSrc && !video.ended
  const currentTime = video.currentTime

  if (
    watchdog.observe({ nowMs: Date.now(), currentTime, expectPlaying })
  ) {
    const index = props.manifest.items.findIndex((i) => i.id === item.id)
    if (index >= 0) reportError(index, 'video stalled')
    return
  }
  // Real progress clears the error budget, so a clip that hiccups once an hour
  // never drifts into the stalled banner. "Real" means relative to a previous
  // sample of THIS load — `lastSeenTime < 0` is the post-reset sentinel, and
  // comparing against it would count the freshly reloaded element's
  // currentTime of 0 as progress, wiping the count after every retry and
  // leaving a permanently frozen clip looping stall→retry with no escalation.
  if (expectPlaying && lastSeenTime >= 0 && currentTime > lastSeenTime) {
    consecutiveErrors = 0
  }
  lastSeenTime = currentTime
}

function onVideoEnded(slot: 'A' | 'B'): void {
  if (slot !== frontSlot()) return
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  consecutiveErrors = 0
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) props.scheduler.itemEnded(index)
}

function onVideoError(slot: 'A' | 'B'): void {
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) reportError(index, 'video decode/load error')
}

function onImgError(slot: 'A' | 'B'): void {
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) reportError(index, 'image load error')
}

function onImgLoad(): void {
  consecutiveErrors = 0
}

function mountInitial(): void {
  // Put item 0 in the front slot; item 1 in the back slot (may equal 0
  // in single-item mode — that's fine, the stage's display logic is idempotent).
  const front = props.manifest.items[props.scheduler.getFrontIndex()] ?? null
  const back = props.manifest.items[props.scheduler.getBackIndex()] ?? null
  setItemInSlot(frontSlot(), front)
  setItemInSlot(backSlot(), back)
  playFrontVideoIfNeeded()
  resetProgressTracking()
}

onMounted(() => {
  mountInitial()
  stallTimer = window.setInterval(sampleProgress, STALL_SAMPLE_MS)

  const unsubTransition = props.scheduler.onTransition((e) => {
    // The NEW front is the current back slot — flip which slot is front.
    frontIsA.value = !frontIsA.value
    // The old front (now back) becomes the next preload target.
    const nextItem = props.manifest.items[e.nextPreload] ?? null
    setItemInSlot(backSlot(), nextItem)
    playFrontVideoIfNeeded()
    resetProgressTracking()
  })
  const unsubStart = props.scheduler.onItemStart(() => {
    // For single-image we re-emit onItemStart(0) from inside the scheduler; we
    // don't need to do anything here — the image element stays mounted.
  })

  onBeforeUnmount(() => {
    unsubTransition()
    unsubStart()
    clearRecoveryTimer()
    if (stallTimer !== null) {
      window.clearInterval(stallTimer)
      stallTimer = null
    }
  })
})

// NOTE: the parent (`app/pages/player.vue`) passes `:key` bound to
// `manifest.playlistId + ':' + manifest.version` so this component is
// remounted (not re-rendered) on any manifest change. That gives us
// clean scheduler subscription lifecycles without watching props here.
</script>

<template>
  <div class="stage">
    <div class="slot" :class="{ front: frontIsA, back: !frontIsA }">
      <video
        ref="videoA"
        muted
        playsinline
        preload="auto"
        :style="{ display: itemInA?.type === 'video' ? 'block' : 'none' }"
        @ended="onVideoEnded('A')"
        @error="onVideoError('A')"
      />
      <img
        ref="imgA"
        alt=""
        :style="{ display: itemInA?.type === 'image' ? 'block' : 'none' }"
        @load="onImgLoad"
        @error="onImgError('A')"
      />
    </div>
    <div class="slot" :class="{ front: !frontIsA, back: frontIsA }">
      <video
        ref="videoB"
        muted
        playsinline
        preload="auto"
        :style="{ display: itemInB?.type === 'video' ? 'block' : 'none' }"
        @ended="onVideoEnded('B')"
        @error="onVideoError('B')"
      />
      <img
        ref="imgB"
        alt=""
        :style="{ display: itemInB?.type === 'image' ? 'block' : 'none' }"
        @load="onImgLoad"
        @error="onImgError('B')"
      />
    </div>
    <div v-if="stalled" class="stalled-banner">Playback stalled — waiting for next sync…</div>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
}

.slot {
  position: absolute;
  inset: 0;
  transition: opacity 120ms linear;
}

.slot.front {
  z-index: 2;
  opacity: 1;
}

.slot.back {
  z-index: 1;
  opacity: 0;
}

.slot video,
.slot img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.stalled-banner {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  color: #f4f4f5;
  background: rgba(0, 0, 0, 0.6);
  padding: 8px 16px;
  border-radius: 6px;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  z-index: 10;
}
</style>
