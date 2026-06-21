<!-- app/pages/apk.vue -->
<script setup lang="ts">
import type { ApkRelease } from '~/app/types/api'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const api = useApiClient()
const toast = useToast()

const releases = ref<ApkRelease[]>([])
const loading = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const versionInput = ref('')

async function load() {
  loading.value = true
  try {
    releases.value = await api.listApkReleases()
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!versionInput.value.trim()) {
    toast.add({ title: t('apk.enterVersionFirst'), color: 'warning' })
    if (fileInput.value) fileInput.value.value = ''
    return
  }
  const form = new FormData()
  form.append('file', file)
  form.append('version', versionInput.value.trim())
  uploading.value = true
  try {
    await api.uploadApk(form)
    toast.add({ title: t('apk.uploaded'), color: 'success' })
    versionInput.value = ''
    await load()
  } catch (err: any) {
    toast.add({ title: t('apk.uploadFailed'), description: err.data?.message ?? err.message, color: 'error' })
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function deleteRelease(release: ApkRelease) {
  try {
    await api.deleteApkRelease(release.id)
    releases.value = releases.value.filter((r) => r.id !== release.id)
    toast.add({ title: t('apk.deleted'), color: 'success' })
  } catch (err: any) {
    toast.add({ title: t('apk.deleteFailed'), description: err.data?.message ?? err.message, color: 'error' })
  }
}

function formatBytes(b: number) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

const columns = computed(() => [
  { key: 'version', label: t('apk.colVersion') },
  { key: 'size', label: t('apk.colSize') },
  { key: 'sha256', label: t('apk.colSha256') },
  { key: 'uploadedAt', label: t('apk.colUploaded') },
  { key: 'actions', label: '' }
])
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('apk.pageTitle')"
      :subtitle="$t('apk.pageSubtitle')"
      icon="i-lucide-package"
    />

    <!-- Upload card -->
    <UCard class="mb-6">
      <template #header>
        <span class="font-medium">{{ $t('apk.uploadCard') }}</span>
      </template>
      <div class="flex flex-wrap items-end gap-3">
        <UFormField :label="$t('apk.colVersion')">
          <UInput
            v-model="versionInput"
            :placeholder="$t('apk.versionPlaceholder')"
            class="w-48"
          />
        </UFormField>
        <UButton
          :loading="uploading"
          leading-icon="i-lucide-upload"
          color="primary"
          @click="fileInput?.click()"
        >
          {{ $t('apk.chooseApk') }}
        </UButton>
        <input
          ref="fileInput"
          type="file"
          accept=".apk"
          class="hidden"
          @change="onFileChange"
        />
      </div>
    </UCard>

    <!-- Releases table -->
    <UCard>
      <template #header>
        <span class="font-medium">{{ $t('apk.releasesCard', { n: releases.length }) }}</span>
      </template>

      <USkeleton v-if="loading && releases.length === 0" class="h-24 w-full" />

      <EmptyState
        v-else-if="!loading && releases.length === 0"
        icon="i-lucide-package"
        :title="$t('apk.emptyTitle')"
        :description="$t('apk.emptyDescription')"
      />

      <UTable
        v-else
        :rows="releases"
        :columns="columns"
      >
        <template #size-data="{ row }">
          {{ formatBytes(row.size) }}
        </template>
        <template #sha256-data="{ row }">
          <code class="text-xs">{{ row.sha256.slice(0, 12) }}…</code>
        </template>
        <template #uploadedAt-data="{ row }">
          {{ new Date(row.uploadedAt).toLocaleString() }}
        </template>
        <template #actions-data="{ row }">
          <div class="flex gap-2">
            <UButton
              size="xs"
              variant="ghost"
              leading-icon="i-lucide-download"
              :to="api.apkDownloadUrl(row.id)"
              target="_blank"
            >
              {{ $t('apk.download') }}
            </UButton>
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              leading-icon="i-lucide-trash-2"
              @click="deleteRelease(row)"
            >
              {{ $t('apk.delete') }}
            </UButton>
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
