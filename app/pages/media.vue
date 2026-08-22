<!-- app/pages/media.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import type { MediaListRow } from '~/app/types/api'

definePageMeta({ layout: 'default' })

const { t } = useI18n()

const store = useMediaStore()
const confirm = useConfirm()
const toast = useToast()

const showUpload = ref(false)
const selectedId = ref<number | null>(null)

onMounted(() => {
  store.refresh()
  store.pollUploads()
})
onUnmounted(() => store.stopPolling())

// Terminal failures surface once as toasts (the placeholder card disappears).
watch(
  () => store.failedUploads.length,
  (n) => {
    if (n === 0) return
    for (const j of store.takeFailedUploads()) {
      toast.add({
        title: t('media.processingFailed', { name: j.filename }),
        description: j.error ?? '',
        color: 'error'
      })
    }
  }
)

async function remove(m: MediaListRow) {
  const used = m.usedInPlaylists > 0
  const ok = await confirm({
    title: t('media.deleteConfirmTitle', { name: m.filename }),
    description: used
      ? t('media.deleteConfirmUsed', m.usedInPlaylists, { n: m.usedInPlaylists })
      : t('media.deleteConfirmUnused'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await store.delete(m.id, { force: used })
    toast.add({ title: t('media.deleted'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('media.deleteFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('nav.media')"
      :subtitle="$t('media.pageSubtitle')"
      icon="i-lucide-image"
    >
      <template #actions>
        <UButton color="primary" icon="i-lucide-upload" @click="showUpload = true">
          {{ $t('media.upload') }}
        </UButton>
      </template>
    </PageHeader>

    <USkeleton v-if="store.loading && store.list.length === 0 && store.uploads.length === 0" class="h-32 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0 && store.uploads.length === 0"
      icon="i-lucide-image"
      :title="$t('media.emptyTitle')"
      :description="$t('media.emptyDescription')"
    >
      <UButton color="primary" icon="i-lucide-upload" @click="showUpload = true">
        {{ $t('media.uploadFirstFile') }}
      </UButton>
    </EmptyState>
    <div v-else class="grid grid-cols-4 gap-4">
      <MediaProcessingCard v-for="j in store.uploads" :key="j.id" :job="j" />
      <MediaCard
        v-for="m in store.list"
        :key="m.id"
        :media="m"
        @select="selectedId = m.id"
        @delete="remove"
      />
    </div>

    <MediaUploadDialog
      v-model="showUpload"
      @uploaded="store.refresh()"
    />

    <MediaDetailDrawer
      :media-id="selectedId"
      @update:open="selectedId = null"
      @changed="store.refresh()"
    />
  </div>
</template>
