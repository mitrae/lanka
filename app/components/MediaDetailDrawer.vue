<!-- app/components/MediaDetailDrawer.vue -->
<script setup lang="ts">
import type { MediaDetail, Organization } from '~/app/types/api'
import { downloadName, mediaFileUrl } from './MediaDetailDrawer.logic'

const props = defineProps<{ mediaId: number | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; changed: [] }>()

const api = useApiClient()
const { t } = useI18n()
const toast = useToast()

const detail = ref<MediaDetail | null>(null)
const orgs = ref<Organization[]>([])
const editingName = ref(false)
const nameDraft = ref('')
const renaming = ref(false)
const open = computed({ get: () => props.mediaId !== null, set: (v) => { if (!v) emit('update:open', false) } })
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  if (props.mediaId === null) return
  // The 5 s poll must not yank the field out from under a rename in progress.
  if (editingName.value) return
  detail.value = await api.getMediaDetail(props.mediaId)
}

function startRename() {
  if (!detail.value) return
  nameDraft.value = detail.value.filename
  editingName.value = true
}

async function saveRename() {
  const current = detail.value
  const next = nameDraft.value.trim()
  if (!current || !next) return
  if (next === current.filename) {
    editingName.value = false
    return
  }
  renaming.value = true
  try {
    const updated = await api.updateMedia(current.id, { filename: next })
    current.filename = updated.filename
    editingName.value = false
    emit('changed')
    toast.add({ title: t('media.renamed'), color: 'success' })
  } catch (e: any) {
    toast.add({
      title: t('media.renameFailed'),
      description: e?.data?.message ?? e?.message,
      color: 'error'
    })
  } finally {
    renaming.value = false
  }
}

async function assignOrg(organizationId: number | null) {
  if (!detail.value) return
  try {
    const updated = await api.assignMediaOrganization(detail.value.id, { organizationId })
    detail.value.organizationId = updated.organizationId
    emit('changed')
    toast.add({ title: t('media.orgUpdated'), color: 'success' })
  } catch (e: any) {
    toast.add({ title: t('media.orgUpdateFailed'), description: e?.data?.message ?? e?.message, color: 'error' })
  }
}

watch(() => props.mediaId, async (id) => {
  if (timer) { clearInterval(timer); timer = null }
  detail.value = null
  editingName.value = false
  if (id !== null) {
    await load()
    if (orgs.value.length === 0) orgs.value = await api.listOrganizations()
    timer = setInterval(load, 5000)
  }
})

onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <USlideover
    :open="open"
    :title="detail?.filename ?? $t('media.details')"
    @update:open="(v) => { if (!v) emit('update:open', false) }"
  >
    <template #body>
      <div v-if="detail" class="space-y-6">
        <!-- Preview the exact transcoded bytes the TVs receive. Handy when a
             clip misbehaves on a box: if it plays here but not there, the
             problem is the box's decoder, not the file. -->
        <div class="space-y-2">
          <video
            v-if="detail.kind === 'video'"
            :key="detail.sha256"
            :src="mediaFileUrl(detail.sha256)"
            controls
            playsinline
            preload="metadata"
            class="w-full rounded-md bg-black"
          />
          <img
            v-else
            :key="detail.sha256"
            :src="mediaFileUrl(detail.sha256)"
            :alt="detail.filename"
            class="w-full rounded-md bg-black object-contain"
          >
          <UButton
            :to="mediaFileUrl(detail.sha256)"
            :download="downloadName(detail.filename, detail.mimeType)"
            external
            color="neutral"
            variant="subtle"
            size="sm"
            icon="i-lucide-download"
            block
          >
            {{ $t('media.download') }}
          </UButton>
        </div>

        <div>
          <p class="mb-1 text-sm text-(--ui-text-muted)">{{ $t('media.nameLabel') }}</p>
          <div v-if="editingName" class="flex flex-col gap-2">
            <div class="flex gap-2">
              <UInput v-model="nameDraft" class="flex-1" autofocus @keyup.enter="saveRename" @keyup.esc="editingName = false" />
              <UButton color="primary" :loading="renaming" :disabled="!nameDraft.trim()" @click="saveRename">
                {{ $t('common.save') }}
              </UButton>
              <UButton color="neutral" variant="ghost" @click="editingName = false">
                {{ $t('common.cancel') }}
              </UButton>
            </div>
            <p class="text-xs text-(--ui-text-muted)">{{ $t('media.renameHint') }}</p>
          </div>
          <div v-else class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate font-medium" :title="detail.filename">{{ detail.filename }}</p>
            <UButton
              variant="ghost" color="neutral" size="xs" icon="i-lucide-pencil"
              :aria-label="$t('media.rename')"
              @click="startRename"
            />
          </div>
        </div>

        <dl class="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <dt class="text-(--ui-text-muted)">{{ $t('media.plays') }}</dt>
          <dd class="tabular-nums font-medium">{{ detail.playCount }}</dd>
          <dt class="text-(--ui-text-muted)">{{ $t('media.type') }}</dt>
          <dd>{{ detail.mimeType }}</dd>
          <dt class="text-(--ui-text-muted)">{{ $t('media.size') }}</dt>
          <dd>{{ formatBytes(detail.bytes) }}</dd>
          <template v-if="detail.width">
            <dt class="text-(--ui-text-muted)">{{ $t('media.dimensions') }}</dt>
            <dd>{{ detail.width }}×{{ detail.height }}</dd>
          </template>
          <template v-if="detail.durationMs">
            <dt class="text-(--ui-text-muted)">{{ $t('media.duration') }}</dt>
            <dd>{{ Math.round(detail.durationMs / 1000) }}s</dd>
          </template>
          <template v-if="detail.kind === 'video'">
            <dt class="text-(--ui-text-muted)">{{ $t('media.quality') }}</dt>
            <dd>
              <UBadge color="neutral" variant="subtle" size="sm">{{ detail.quality }}</UBadge>
            </dd>
          </template>
          <dt class="text-(--ui-text-muted)">{{ $t('media.uploaded') }}</dt>
          <dd>{{ new Date(detail.createdAt).toLocaleString() }}</dd>
          <dt class="text-(--ui-text-muted)">sha256</dt>
          <dd class="truncate font-mono text-xs">{{ detail.sha256 }}</dd>
        </dl>

        <div>
          <p class="mb-1 text-sm text-(--ui-text-muted)">{{ $t('media.organization') }}</p>
          <USelect
            :model-value="detail.organizationId ?? undefined"
            :items="orgs.map(o => ({ label: o.name, value: o.id }))"
            value-key="value"
            label-key="label"
            :placeholder="$t('media.noOrganization')"
            @update:model-value="(v: any) => assignOrg(v ?? null)"
          />
          <UButton
            v-if="detail.organizationId"
            variant="link"
            size="xs"
            class="mt-1"
            @click="assignOrg(null)"
          >
            {{ $t('media.clearOrganization') }}
          </UButton>
        </div>

        <div>
          <p class="mb-1 text-sm text-(--ui-text-muted)">
            {{ $t('media.usedInPlaylists') }} ({{ detail.playlists.length }})
          </p>
          <ul class="space-y-1 text-sm">
            <li v-for="p in detail.playlists" :key="p.id">{{ p.name }}</li>
            <li v-if="detail.playlists.length === 0" class="text-(--ui-text-muted)">{{ $t('media.notUsed') }}</li>
          </ul>
        </div>
      </div>
      <div v-else class="flex items-center justify-center py-12 text-(--ui-text-muted)">
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      </div>
    </template>
  </USlideover>
</template>
