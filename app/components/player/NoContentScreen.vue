<!-- app/components/player/NoContentScreen.vue -->
<script setup lang="ts">
defineProps<{ deviceId: string }>()
</script>

<template>
  <div class="screen">
    <div class="center">
      <div class="dot" />
      <div class="title">No content assigned</div>
      <div class="device-id">{{ deviceId }}</div>
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
  gap: 16px;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #10b981;
  animation: pulse 1.6s ease-in-out infinite;
}
.title {
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 24px;
  font-weight: 500;
}
.device-id {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: #71717a;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}
</style>
