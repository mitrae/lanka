<!-- app/pages/media.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import type { MediaListRow } from '~/app/types/api'

definePageMeta({ layout: 'default' })

const store = useMediaStore()
const confirm = useConfirm()
const toast = useToast()

const showUpload = ref(false)

onMounted(() => store.refresh())

async function remove(m: MediaListRow) {
  const used = m.usedInPlaylists > 0
  const ok = await confirm({
    title: `Delete ${m.filename}?`,
    description: used
      ? `This file is used in ${m.usedInPlaylists} playlist(s). ` +
        `Deleting will remove those entries and bump each playlist version.`
      : 'Removes the file and its thumbnail permanently.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await store.delete(m.id, { force: used })
    toast.add({ title: 'Deleted', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>Media library</template>
    <div class="flex items-center justify-between">
      <p class="text-sm text-(--ui-text-muted)">
        Upload videos and images. Playlists reference media from this library.
      </p>
      <UButton
        color="primary"
        icon="i-lucide-upload"
        @click="showUpload = true"
      >
        Upload
      </UButton>
    </div>

    <USkeleton v-if="store.loading && store.list.length === 0" class="mt-6 h-32 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      class="mt-6"
      icon="i-lucide-image"
      title="No media yet"
      description="Upload videos or images to start building playlists."
    >
      <UButton
        color="primary"
        icon="i-lucide-upload"
        @click="showUpload = true"
      >
        Upload your first file
      </UButton>
    </EmptyState>
    <div v-else class="mt-6 grid grid-cols-4 gap-4">
      <MediaCard
        v-for="m in store.list"
        :key="m.id"
        :media="m"
        @delete="remove"
      />
    </div>

    <MediaUploadDialog
      v-model="showUpload"
      @uploaded="store.refresh()"
    />
  </div>
</template>
