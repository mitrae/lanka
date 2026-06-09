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

onMounted(() => store.refresh())

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

    <USkeleton v-if="store.loading && store.list.length === 0" class="h-32 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      icon="i-lucide-image"
      :title="$t('media.emptyTitle')"
      :description="$t('media.emptyDescription')"
    >
      <UButton color="primary" icon="i-lucide-upload" @click="showUpload = true">
        {{ $t('media.uploadFirstFile') }}
      </UButton>
    </EmptyState>
    <div v-else class="grid grid-cols-4 gap-4">
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
