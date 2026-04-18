<!-- app/components/StatusDot.vue -->
<script setup lang="ts">
import type { DeviceStatus } from '~/app/types/api'
defineProps<{ status: DeviceStatus; label?: boolean }>()
</script>

<template>
  <span class="inline-flex items-center gap-2 text-xs">
    <span
      class="size-2 rounded-full"
      :class="{
        'bg-emerald-500': status === 'online',
        'bg-amber-500': status === 'idle',
        'bg-rose-500': status === 'offline'
      }"
    />
    <span v-if="label" class="capitalize">{{ status }}</span>
  </span>
</template>
