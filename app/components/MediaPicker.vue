<!-- app/components/MediaPicker.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import type { MediaListRow } from '~/app/types/api'

const emit = defineEmits<{ (e: 'pick', m: MediaListRow): void }>()

const store = useMediaStore()
const search = ref('')

onMounted(() => {
  if (store.list.length === 0) store.refresh()
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.list
  return store.list.filter((m) => m.filename.toLowerCase().includes(q))
})
</script>

<template>
  <div>
    <UInput
      v-model="search"
      :placeholder="$t('components.mediaPicker.searchPlaceholder')"
      icon="i-lucide-search"
      class="w-full"
    />
    <div class="mt-3 grid grid-cols-3 gap-2 max-h-96 overflow-y-auto pr-1">
      <button
        v-for="m in filtered"
        :key="m.id"
        type="button"
        class="group overflow-hidden rounded-xl border border-(--ui-border) bg-(--ui-bg) text-left transition-colors hover:border-indigo-500"
        @click="emit('pick', m)"
      >
        <div class="aspect-video bg-zinc-900">
          <img
            v-if="m.thumbnailBytes"
            :src="`/media/${m.sha256}/thumb`"
            :alt="m.filename"
            class="h-full w-full object-cover"
          />
          <div
            v-else
            class="flex h-full items-center justify-center text-(--ui-text-muted)"
          >
            <UIcon
              :name="m.kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
              class="size-6"
            />
          </div>
        </div>
        <p class="truncate p-2 text-xs">{{ m.filename }}</p>
      </button>
    </div>
  </div>
</template>
