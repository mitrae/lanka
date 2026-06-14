<script setup lang="ts">
import type { DeviceNowPlaying } from '~/app/types/api'
const props = defineProps<{ status: DeviceNowPlaying | null }>()
const thumb = computed(() =>
  props.status?.currentItem ? `/media/${props.status.currentItem.sha256}/thumb` : null
)
</script>

<template>
  <div class="soft-card p-5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-(--ui-text-highlighted)">{{ $t('devices.nowPlaying') }}</h3>
      <span
        class="rounded-full px-2 py-0.5 text-xs"
        :class="status?.online ? 'bg-emerald-500/15 text-emerald-600' : 'bg-(--ui-bg-accented) text-(--ui-text-muted)'"
      >{{ status?.online ? $t('devices.online') : $t('devices.offline') }}</span>
    </div>
    <div v-if="status?.currentItem" class="mt-4 flex items-center gap-3">
      <img v-if="thumb" :src="thumb" class="h-16 w-28 rounded object-cover bg-black" alt="" />
      <div>
        <p class="font-medium text-(--ui-text-highlighted)">{{ status.currentItem.filename }}</p>
        <p class="text-sm text-(--ui-text-muted)">
          {{ status.currentItem.kind === 'video' ? $t('components.playlistItemRow.video') : $t('components.playlistItemRow.image') }}
          · {{ status.playlistName }}
        </p>
      </div>
    </div>
    <p v-else class="mt-4 text-sm text-(--ui-text-muted)">{{ $t('devices.nothingPlaying') }}</p>
  </div>
</template>
