<!-- app/components/player/PlayerStage.vue -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Manifest, ManifestItem } from '~/app/types/api'
import type { SchedulerHandle } from '~/app/composables/player/createPlayerScheduler'
import type { PlayerEnv } from '~/app/composables/player/usePlayerEnv'

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

// Consecutive error count — bail to a "stalled" state if we can't make progress.
let consecutiveErrors = 0
const stalled = ref(false)

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

function playFrontVideoIfNeeded(): void {
  const item =
    frontIsA.value ? itemInA.value : itemInB.value
  if (!item || item.type !== 'video') return
  const { video } = elementsFor(frontSlot())
  if (!video) return
  // Single-video mode: let the native loop attribute handle continuous play.
  video.loop = props.scheduler.mode === 'single-video'
  void video.play().catch(() => {
    /* autoplay is muted; failures are swallowed and reported on error */
  })
}

function reportError(index: number, msg: string): void {
  consecutiveErrors += 1
  if (consecutiveErrors >= 5) {
    stalled.value = true
    props.scheduler.stop()
    return
  }
  props.scheduler.itemErrored(index, msg)
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
  const frontItem = props.manifest.items[props.scheduler.getFrontIndex()] ?? null
  const backItem = props.manifest.items[props.scheduler.getBackIndex()] ?? null
  setItemInSlot(frontSlot(), frontItem)
  setItemInSlot(backSlot(), backItem)
  playFrontVideoIfNeeded()
}

onMounted(() => {
  mountInitial()

  const unsubTransition = props.scheduler.onTransition((e) => {
    // The NEW front is the current back slot — flip which slot is front.
    frontIsA.value = !frontIsA.value
    // The old front (now back) becomes the next preload target.
    const nextItem = props.manifest.items[e.nextPreload] ?? null
    setItemInSlot(backSlot(), nextItem)
    playFrontVideoIfNeeded()
  })
  const unsubStart = props.scheduler.onItemStart(() => {
    // For single-image we re-emit onItemStart(0) from inside the scheduler; we
    // don't need to do anything here — the image element stays mounted.
  })

  onBeforeUnmount(() => {
    unsubTransition()
    unsubStart()
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
