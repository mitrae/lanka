<!-- app/components/MediaProcessingCard.vue -->
<script setup lang="ts">
import type { UploadJob } from '~/app/types/api'

const props = defineProps<{ job: UploadJob }>()
</script>

<template>
  <div class="relative overflow-hidden soft-card opacity-90" :title="props.job.filename">
    <div class="flex aspect-video items-center justify-center bg-zinc-900 text-(--ui-text-muted)">
      <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin" />
    </div>
    <div class="p-3">
      <p class="truncate text-sm font-medium">{{ props.job.filename }}</p>
      <div class="mt-1 flex items-center justify-between text-xs text-(--ui-text-muted)">
        <span>{{ formatBytes(props.job.bytes) }}</span>
        <UBadge size="sm" color="neutral" variant="soft">
          {{ $t(`media.uploadStatus.${props.job.status}`) }}
        </UBadge>
      </div>
    </div>
  </div>
</template>
