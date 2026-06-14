<!-- app/components/MediaDetailDrawer.vue -->
<script setup lang="ts">
import type { MediaDetail, Organization } from '~/app/types/api'

const props = defineProps<{ mediaId: number | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; changed: [] }>()

const api = useApiClient()
const { t } = useI18n()
const toast = useToast()

const detail = ref<MediaDetail | null>(null)
const orgs = ref<Organization[]>([])
const open = computed({ get: () => props.mediaId !== null, set: (v) => { if (!v) emit('update:open', false) } })
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  if (props.mediaId === null) return
  detail.value = await api.getMediaDetail(props.mediaId)
}

function humanBytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let b = n
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`
}

async function assignOrg(organizationId: number | null) {
  if (!detail.value) return
  try {
    await api.assignMediaOrganization(detail.value.id, { organizationId })
    detail.value.organizationId = organizationId
    emit('changed')
    toast.add({ title: t('media.orgUpdated'), color: 'success' })
  } catch (e: any) {
    toast.add({ title: t('media.orgUpdateFailed'), description: e?.data?.message ?? e?.message, color: 'error' })
  }
}

watch(() => props.mediaId, async (id) => {
  if (timer) { clearInterval(timer); timer = null }
  detail.value = null
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
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt class="text-(--ui-text-muted)">{{ $t('media.plays') }}</dt>
          <dd class="tabular-nums font-medium">{{ detail.playCount }}</dd>
          <dt class="text-(--ui-text-muted)">{{ $t('media.type') }}</dt>
          <dd>{{ detail.mimeType }}</dd>
          <dt class="text-(--ui-text-muted)">{{ $t('media.size') }}</dt>
          <dd>{{ humanBytes(detail.bytes) }}</dd>
          <template v-if="detail.width">
            <dt class="text-(--ui-text-muted)">{{ $t('media.dimensions') }}</dt>
            <dd>{{ detail.width }}×{{ detail.height }}</dd>
          </template>
          <template v-if="detail.durationMs">
            <dt class="text-(--ui-text-muted)">{{ $t('media.duration') }}</dt>
            <dd>{{ Math.round(detail.durationMs / 1000) }}s</dd>
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
    </template>
  </USlideover>
</template>
