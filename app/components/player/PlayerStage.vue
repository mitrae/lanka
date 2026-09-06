<!-- app/components/player/PlayerStage.vue -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Manifest, ManifestItem } from '~/app/types/api'
import type { SchedulerHandle } from '~/app/composables/player/createPlayerScheduler'
import type { PlayerEnv } from '~/app/composables/player/usePlayerEnv'
import { createStallWatchdog } from '~/app/composables/player/createStallWatchdog'
import { describeMediaError } from '~/app/composables/player/describeMediaError'

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
// Mid-clip freeze: media time frozen after the element has already decoded.
const STALL_PLAYING_MS = 8000
// Cold load: currentTime sits at 0 while the moov atom and first GOP arrive. On
// the CDN fallback path (cache miss, or MediaCache's storage guard silently
// skipped the download) that is a 176 MB fetch over the venue uplink. Reloading
// at 8 s would discard the buffered progress and restart the clock — a loop
// that never converges on a slow link.
const STALL_STARTUP_MS = 45_000
// Media seconds a load must advance before earlier failures are forgiven. One
// frame every few seconds is a crawling decoder, not health, and must not keep
// wiping the backoff budget.
const HEALTHY_PROGRESS_SECS = 5
const watchdog = createStallWatchdog({ startupMs: STALL_STARTUP_MS, playingMs: STALL_PLAYING_MS })
let stallTimer: number | null = null
let everDecoded = false // this load has reached HAVE_CURRENT_DATA at least once

// Interceptor bypass. On the APK the media URL is answered by MediaCache's
// shouldInterceptRequest once the file is cached, and on at least one TV
// (Haier, Chrome 152 WebView, APK 0.4.0) the media pipeline rejects that
// response instantly — the clip streams fine from the CDN for the ~10 minutes
// the background download takes, then errors on every load once cached
// (prod, 2026-09-06). fetch() does not care about the media pipeline's
// objections, so after a direct-URL failure the bytes are fetched once and
// played from a blob: URL. The fetch goes to the SAME-ORIGIN /media/<sha>
// path, never the CDN: a cross-origin fetch needs CORS headers, and an
// intercepted (cached) response carries none. One attempt per item per
// recovery cycle; a blob that itself fails to play marks the item so no more
// 60 MB fetches are spent on bytes the pipeline has already rejected.
const blobUrlBySlot: Record<'A' | 'B', string | null> = { A: null, B: null }
const blobState = new Map<number, 'tried' | 'failed'>()

function releaseBlob(slot: 'A' | 'B'): void {
  const url = blobUrlBySlot[slot]
  if (url) URL.revokeObjectURL(url)
  blobUrlBySlot[slot] = null
}
let budgetAnchorTime = -1 // currentTime when the error budget was last charged/forgiven
let playNudged = false // a paused stall already got its one play() before a reload

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
    // A new cycle gets one more blob attempt per item — unless the blob
    // itself was rejected, which is permanent for this mount.
    for (const [id, st] of blobState) if (st === 'tried') blobState.delete(id)
    mountInitial()
  }, RECOVERY_DELAY_MS)
}

/** Forget any in-flight stall window — after a retry, a slot swap or a
 *  remount the element starts from a clean slate. */
function resetProgressTracking(): void {
  watchdog.reset()
  everDecoded = false
  budgetAnchorTime = -1
  playNudged = false
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
  releaseBlob(slot)

  if (!video || !img) return

  // Release whatever this slot held before. `display:none` hides an element
  // but frees nothing — the demuxer, decoder instance and decoded bitmap stay
  // allocated — and on a 2 GB box that compounds the pressure a single-item
  // playlist already creates. Removing src + load() is the spec'd way to
  // empty a media element; it fires no `error`.
  if (!item || item.type !== 'video') {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  if (!item || item.type !== 'image') img.removeAttribute('src')
  if (!item) return

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
  budgetAnchorTime = -1 // forgiveness needs fresh sustained progress from here
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    // Record it first: this is the failure that trips the stalled state, and
    // it used to be the one failure that never reached device_errors. Then
    // pause error-driven advancing and retry after a delay. Do NOT call
    // scheduler.stop() — that permanently clears its handlers, so the screen
    // could only ever recover via a manifest change (operator action).
    props.scheduler.noteError(index, msg)
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
  // HAVE_CURRENT_DATA = at least one frame decoded for this load. Selects the
  // startup vs mid-play threshold. Latched, because readyState drops back to
  // HAVE_METADATA during a buffer underrun — which is exactly the mid-play
  // freeze the short threshold exists to catch.
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) everDecoded = true

  // `paused` is deliberately NOT part of expectPlaying: a front video that
  // ended up paused (rejected play(), dead decoder) is a fault we want to
  // recover from. It gets one cheap play() nudge before the full reload.
  const expectPlaying = !!video.currentSrc && !video.ended
  const currentTime = video.currentTime

  const stalledNow = watchdog.observe({
    nowMs: Date.now(),
    currentTime,
    expectPlaying,
    started: everDecoded
  })
  if (stalledNow) {
    if (video.paused && !playNudged) {
      // Cheapest recovery first: an interrupted play() needs another play(),
      // not a reload that throws away buffered data. One attempt — if media
      // time still does not move, the next window escalates to reportError.
      playNudged = true
      void video.play().catch(() => {})
      return
    }
    const index = props.manifest.items.findIndex((i) => i.id === item.id)
    if (index >= 0) {
      reportError(index, everDecoded ? 'video stalled' : 'video never started')
    }
    return
  }

  // Sustained progress forgives earlier failures, so a clip that hiccups once
  // an hour never drifts into the stalled banner. Sustained = HEALTHY_PROGRESS_SECS
  // of media time since the budget was last charged. The anchor is re-taken on
  // the first sample after a charge (a freshly reloaded element's 0 is not
  // progress) and on a loop wrap (currentTime jumps backwards).
  if (!expectPlaying) return
  if (budgetAnchorTime < 0 || currentTime < budgetAnchorTime) {
    budgetAnchorTime = currentTime
    return
  }
  if (currentTime - budgetAnchorTime >= HEALTHY_PROGRESS_SECS) {
    consecutiveErrors = 0
    budgetAnchorTime = currentTime
  }
}

function onVideoEnded(slot: 'A' | 'B'): void {
  if (slot !== frontSlot()) return
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  consecutiveErrors = 0
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index >= 0) props.scheduler.itemEnded(index)
}

/** Route a media element's failure by which slot it came from. Only the
 *  visible slot may drive playback; a failure in the hidden preload slot is
 *  recorded for telemetry and nothing else. Before this guard existed, a
 *  back-slot error charged the error budget and — once retryFrontItem was
 *  added — reloaded the perfectly healthy front video from 0. */
function onSlotError(slot: 'A' | 'B', msg: string): void {
  const item = slot === 'A' ? itemInA.value : itemInB.value
  if (!item) return
  const index = props.manifest.items.findIndex((i) => i.id === item.id)
  if (index < 0) return
  if (slot !== frontSlot()) {
    props.scheduler.noteError(index, `${msg} (preload)`)
    return
  }
  reportError(index, msg)
}

function onVideoError(slot: 'A' | 'B'): void {
  const { video } = elementsFor(slot)
  const item = slot === 'A' ? itemInA.value : itemInB.value
  const detail = video
    ? describeMediaError(video.error, {
        networkState: video.networkState,
        readyState: video.readyState,
        source: blobUrlBySlot[slot] ? 'blob' : undefined
      })
    : 'video decode/load error'
  const viaBlob = !!blobUrlBySlot[slot]
  if (viaBlob && item) blobState.set(item.id, 'failed')
  if (!viaBlob && slot === frontSlot() && item?.type === 'video' && video && !blobState.has(item.id)) {
    blobState.set(item.id, 'tried')
    // Record the direct-URL failure, then retry via blob: without charging the
    // error budget — the retry itself decides whether this is a real fault.
    const index = props.manifest.items.findIndex((i) => i.id === item.id)
    if (index >= 0) props.scheduler.noteError(index, `${detail} → retrying via blob`)
    void playViaBlob(slot, item, video)
    return
  }
  onSlotError(slot, detail)
}

async function playViaBlob(slot: 'A' | 'B', item: ManifestItem, video: HTMLVideoElement): Promise<void> {
  // Same-origin on purpose (see the blob comment above). On the APK the
  // interceptor still answers this from the cache; in a browser it is the
  // app's own /media proxy.
  const url = `/media/${item.sha256}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    // The slot may have moved on while we were fetching.
    const stillHere = (slot === 'A' ? itemInA.value : itemInB.value)?.id === item.id
    if (!stillHere) return
    releaseBlob(slot)
    const blobUrl = URL.createObjectURL(blob)
    blobUrlBySlot[slot] = blobUrl
    video.src = blobUrl
    video.load()
    resetProgressTracking()
    if (slot === frontSlot()) playFrontVideoIfNeeded()
  } catch (e) {
    blobState.set(item.id, 'failed')
    onSlotError(slot, `blob fetch failed: ${(e as Error).message}`)
  }
}

function onImgError(slot: 'A' | 'B'): void {
  onSlotError(slot, 'image load error')
}

function onImgLoad(): void {
  consecutiveErrors = 0
}

function mountInitial(): void {
  const frontIdx = props.scheduler.getFrontIndex()
  const backIdx = props.scheduler.getBackIndex()
  const front = props.manifest.items[frontIdx] ?? null
  // Single-item modes report back === front. Loading the same item into the
  // hidden slot as well meant two <video preload="auto"> on one 176 MB file:
  // two demuxers, two buffers and — on an Amlogic box with a handful of
  // hardware decoder instances — a real chance of starving the visible one.
  // Leave the back slot empty instead.
  const back = backIdx === frontIdx ? null : (props.manifest.items[backIdx] ?? null)
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
    const nextItem =
      e.nextPreload === e.to ? null : (props.manifest.items[e.nextPreload] ?? null)
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
