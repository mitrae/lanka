<!-- app/components/PlaylistItemRow.vue -->
<script setup lang="ts">
import type { MediaListRow } from '~/app/types/api'
import type { DraftItem } from '~/app/components/PlaylistEditor.logic'

const props = defineProps<{
  item: DraftItem
  index: number
  media: MediaListRow | null
  total: number
}>()
defineEmits<{
  (e: 'update:duration', ms: number | null): void
  (e: 'remove'): void
  (e: 'move', delta: number): void
}>()
</script>

<template>
  <li
    class="flex items-center gap-3 rounded-xl border border-(--ui-border) bg-(--ui-bg-elevated) p-3 transition-colors hover:border-(--ui-border-accented)"
  >
    <div class="flex flex-col">
      <UButton
        icon="i-lucide-chevron-up"
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="index === 0"
        @click="$emit('move', -1)"
      />
      <UButton
        icon="i-lucide-chevron-down"
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="index === total - 1"
        @click="$emit('move', 1)"
      />
    </div>
    <div class="aspect-video w-32 shrink-0 overflow-hidden rounded bg-zinc-900">
      <img
        v-if="media?.thumbnailBytes"
        :src="`/media/${media.sha256}/thumb`"
        :alt="media.filename"
        class="h-full w-full object-cover"
      />
      <div
        v-else
        class="flex h-full items-center justify-center text-(--ui-text-muted)"
      >
        <UIcon name="i-lucide-image" class="size-5" />
      </div>
    </div>
    <div class="flex-1 min-w-0">
      <p class="truncate text-sm font-medium">
        {{ media?.filename ?? `media #${item.mediaId}` }}
      </p>
      <p class="mt-1 text-xs text-(--ui-text-muted)">
        {{ media?.kind === 'video' ? $t('components.playlistItemRow.video') : $t('components.playlistItemRow.image') }}
      </p>
    </div>
    <div class="flex flex-col gap-1 items-end">
      <label class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
        {{ $t('components.playlistItemRow.durationLabel') }}
        <UInput
          :model-value="item.durationMsOverride !== null ? item.durationMsOverride / 1000 : ''"
          @update:model-value="
            (v) =>
              $emit(
                'update:duration',
                v === '' ? null : Math.round(Number(v) * 1000)
              )
          "
          type="number"
          size="xs"
          :disabled="media?.kind === 'video'"
          :placeholder="media?.kind === 'video' ? $t('components.playlistItemRow.durationPlaceholderNative') : $t('components.playlistItemRow.durationPlaceholderDefault')"
          class="w-20"
        />
      </label>
      <UButton
        icon="i-lucide-x"
        color="error"
        variant="soft"
        size="xs"
        @click="$emit('remove')"
      >
        {{ $t('components.playlistItemRow.remove') }}
      </UButton>
    </div>
  </li>
</template>
