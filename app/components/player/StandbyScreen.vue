<!-- app/components/player/StandbyScreen.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  deviceId: string
  lastError: string | null
}>()

const startedAt = Date.now()
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - startedAt) / 1000)
  }, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const elapsedLabel = computed(() => {
  const s = elapsed.value
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
})
</script>

<template>
  <div class="screen">
    <div class="center">
      <div class="spinner" />
      <div class="title">Connecting…</div>
      <div class="meta">waited {{ elapsedLabel }}</div>
      <div class="device-id">{{ props.deviceId }}</div>
      <div v-if="props.lastError" class="err">{{ props.lastError }}</div>
    </div>
  </div>
</template>

<style scoped>
.screen {
  position: fixed;
  inset: 0;
  background: #000;
  color: #e4e4e7;
  display: flex;
  align-items: center;
  justify-content: center;
}
.center {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid #27272a;
  border-top-color: #10b981;
  animation: spin 0.9s linear infinite;
}
.title {
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 22px;
  font-weight: 500;
}
.meta {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: #a1a1aa;
}
.device-id {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: #52525b;
}
.err {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: #f87171;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
