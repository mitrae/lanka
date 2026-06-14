<!-- app/components/MediaCard.vue -->
<script setup lang="ts">
import type { MediaListRow } from '~/app/types/api'

const props = defineProps<{ media: MediaListRow }>()
const emit = defineEmits<{ (e: 'delete', m: MediaListRow): void; (e: 'select', m: MediaListRow): void }>()

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtDuration(ms: number | null) {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="group relative overflow-hidden soft-card hover-lift cursor-pointer" @click="emit('select', props.media)">
    <div class="aspect-video bg-zinc-900">
      <img
        v-if="media.thumbnailBytes"
        :src="`/media/${media.sha256}/thumb`"
        :alt="media.filename"
        class="h-full w-full object-cover"
      />
      <div
        v-else
        class="flex h-full items-center justify-center text-(--ui-text-muted)"
      >
        <UIcon
          :name="media.kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
          class="size-10"
        />
      </div>
    </div>
    <div class="p-3">
      <p class="truncate text-sm font-medium" :title="media.filename">
        {{ media.filename }}
      </p>
      <div class="mt-1 flex items-center justify-between text-xs text-(--ui-text-muted)">
        <span>
          {{ fmtBytes(media.bytes) }}
          <template v-if="media.durationMs"> · {{ fmtDuration(media.durationMs) }}</template>
        </span>
        <div class="flex items-center gap-1">
          <UBadge
            v-if="media.usedInPlaylists > 0"
            size="sm"
            color="neutral"
            variant="soft"
          >
            {{ $t('components.mediaCard.usedIn', { n: media.usedInPlaylists }) }}
          </UBadge>
          <UBadge
            v-if="media.playCount > 0"
            size="sm"
            color="primary"
            variant="soft"
          >
            {{ media.playCount }}▶
          </UBadge>
          <UIcon
            v-if="media.organizationId != null"
            name="i-lucide-building-2"
            class="size-3.5 text-(--ui-text-muted)"
            title="Assigned to organization"
          />
        </div>
      </div>
    </div>
    <div class="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
      <UButton
        icon="i-lucide-trash-2"
        color="error"
        variant="soft"
        size="xs"
        @click.stop="emit('delete', props.media)"
      />
    </div>
  </div>
</template>
