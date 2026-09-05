<!-- app/pages/media.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import type { MediaListRow } from '~/app/types/api'
import {
  filterByOrganization,
  isOrgFilterActive,
  ORG_FILTER_ALL,
  ORG_FILTER_NONE,
  type OrgFilter
} from '~/app/utils/mediaFilter'

definePageMeta({ layout: 'default' })

const { t } = useI18n()

const store = useMediaStore()
const confirm = useConfirm()
const toast = useToast()

const orgsStore = useOrganizationsStore()

const showUpload = ref(false)
const selectedId = ref<number | null>(null)

const orgFilter = ref<OrgFilter>(ORG_FILTER_ALL)

const orgFilterOptions = computed(() => [
  { label: t('media.allOrganizations'), value: ORG_FILTER_ALL },
  { label: t('media.unassignedOrganization'), value: ORG_FILTER_NONE },
  ...orgsStore.list.map((o) => ({ label: o.name, value: String(o.id) }))
])

const filtered = computed(() => isOrgFilterActive(orgFilter.value))
const visibleMedia = computed(() => filterByOrganization(store.list, orgFilter.value))
// In-flight uploads have no organization yet, so any narrowing filter hides them.
const visibleUploads = computed(() => (filtered.value ? [] : store.uploads))

onMounted(() => {
  store.refresh()
  store.pollUploads()
  orgsStore.refresh()
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

    <div v-if="store.list.length > 0" class="mb-4 flex flex-wrap items-center gap-2">
      <USelect
        v-model="orgFilter"
        :items="orgFilterOptions"
        value-key="value"
        icon="i-lucide-briefcase"
        class="w-full sm:w-56"
        :aria-label="$t('media.filterByOrganization')"
      />
      <UButton
        v-if="filtered"
        variant="ghost"
        color="neutral"
        size="sm"
        icon="i-lucide-x"
        @click="orgFilter = ORG_FILTER_ALL"
      >
        {{ $t('media.clearFilter') }}
      </UButton>
    </div>

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
    <EmptyState
      v-else-if="visibleMedia.length === 0 && visibleUploads.length === 0"
      icon="i-lucide-filter-x"
      :title="$t('media.noMatchTitle')"
    >
      <UButton variant="soft" color="neutral" icon="i-lucide-x" @click="orgFilter = ORG_FILTER_ALL">
        {{ $t('media.clearFilter') }}
      </UButton>
    </EmptyState>
    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
      <MediaProcessingCard v-for="j in visibleUploads" :key="j.id" :job="j" />
      <MediaCard
        v-for="m in visibleMedia"
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
