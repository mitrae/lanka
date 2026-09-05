<!-- app/pages/playlists/[id].vue -->
<script setup lang="ts">
import { useApiClient } from '~/app/composables/useApiClient'
import { useMediaStore } from '~/app/stores/media'
import { usePlaylistsStore } from '~/app/stores/playlists'
import { reorderItems, type DraftItem } from '~/app/components/PlaylistEditor.logic'
import type { MediaListRow, PlaylistDetail } from '~/app/types/api'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApiClient()
const mediaStore = useMediaStore()
const playlistsStore = usePlaylistsStore()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => Number(route.params.id))
const playlist = ref<PlaylistDetail | null>(null)
const drafts = ref<DraftItem[]>([])
const editingName = ref(false)
const editName = ref('')
const saving = ref(false)

async function load() {
  try {
    const [pl] = await Promise.all([api.getPlaylist(id.value), mediaStore.refresh()])
    playlist.value = pl
    editName.value = pl.name
    drafts.value = pl.items.map((i) => ({
      id: i.id,
      mediaId: i.mediaId,
      durationMsOverride: i.durationMsOverride
    }))
  } catch (err: any) {
    toast.add({
      title: t('playlists.loadFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

onMounted(load)

const dirty = computed(() => {
  if (!playlist.value) return false
  if (drafts.value.length !== playlist.value.items.length) return true
  return drafts.value.some((d, i) => {
    const orig = playlist.value!.items[i]
    return d.mediaId !== orig.mediaId || d.durationMsOverride !== orig.durationMsOverride
  })
})

function addItem(m: MediaListRow) {
  drafts.value.push({
    id: null,
    mediaId: m.id,
    durationMsOverride: m.kind === 'image' ? 10_000 : null
  })
}

function removeItem(i: number) {
  drafts.value.splice(i, 1)
}

function move(i: number, delta: number) {
  drafts.value = reorderItems(drafts.value, i, i + delta)
}

function updateDuration(i: number, ms: number | null) {
  drafts.value[i].durationMsOverride = ms
}

function mediaFor(mediaId: number): MediaListRow | null {
  return mediaStore.list.find((m) => m.id === mediaId) ?? null
}

async function saveItems() {
  if (!playlist.value) return
  // Validate: all images must have a duration
  for (const d of drafts.value) {
    const m = mediaFor(d.mediaId)
    if (m?.kind === 'image' && !d.durationMsOverride) {
      toast.add({
        title: t('playlists.fixDurations'),
        description: t('playlists.imageMissingDuration', { name: m.filename }),
        color: 'error'
      })
      return
    }
  }
  saving.value = true
  try {
    await api.replacePlaylistItems(playlist.value.id, {
      items: drafts.value.map((d) => ({
        mediaId: d.mediaId,
        durationMsOverride: d.durationMsOverride ?? undefined
      }))
    })
    await load()
    toast.add({ title: t('playlists.saved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('playlists.saveFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

async function saveName() {
  if (!playlist.value || !editName.value.trim()) return
  try {
    await playlistsStore.update(playlist.value.id, { name: editName.value.trim() })
    playlist.value = await api.getPlaylist(id.value)
    editingName.value = false
    toast.add({ title: t('playlists.renamed'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('playlists.renameFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function deletePlaylist() {
  if (!playlist.value) return
  const ok = await confirm({
    title: t('playlists.deleteConfirmTitle', { name: playlist.value.name }),
    description: t('playlists.deleteConfirmDescription'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await playlistsStore.delete(playlist.value.id)
    router.push('/playlists')
  } catch (err: any) {
    toast.add({
      title: t('playlists.deleteFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <NuxtLink
      to="/playlists"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-(--ui-text-muted) transition-colors hover:text-(--ui-text)"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" /> {{ $t('nav.playlists') }}
    </NuxtLink>

    <div v-if="!playlist">
      <USkeleton class="h-32 w-full" />
    </div>
    <template v-else>
      <section class="soft-card p-4 sm:p-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
              {{ $t('playlists.playlistLabel') }} · <span class="font-mono">{{ $t('playlists.version', { n: playlist.version }) }}</span>
            </p>
            <template v-if="!editingName">
              <h2 class="mt-1 text-2xl font-semibold text-(--ui-text-highlighted)">{{ playlist.name }}</h2>
            </template>
            <template v-else>
              <UInput
                v-model="editName"
                autofocus
                class="mt-1 w-full sm:w-80"
                @keyup.enter="saveName"
              />
            </template>
          </div>
          <div class="flex flex-wrap gap-2">
            <template v-if="!editingName">
              <UButton variant="soft" color="neutral" icon="i-lucide-pencil" @click="editingName = true">
                {{ $t('playlists.rename') }}
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="deletePlaylist"
              >
                {{ $t('common.delete') }}
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="saveName">{{ $t('playlists.saveName') }}</UButton>
              <UButton
                variant="ghost"
                color="neutral"
                @click="editingName = false; editName = playlist!.name"
              >
                {{ $t('common.cancel') }}
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <div class="mt-6 grid grid-cols-1 gap-4 sm:mt-8 sm:gap-6 lg:grid-cols-[1fr_2fr]">
        <section class="soft-card p-4">
          <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">{{ $t('playlists.mediaLibrary') }}</h3>
          <p class="mt-1 text-xs text-(--ui-text-muted)">
            {{ $t('playlists.mediaLibraryHint') }}
          </p>
          <div class="mt-3">
            <MediaPicker @pick="addItem" />
          </div>
        </section>

        <section class="soft-card p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">
              {{ $t('playlists.itemsHeading') }} <span class="font-normal text-(--ui-text-muted)">({{ drafts.length }})</span>
            </h3>
            <UButton
              color="primary"
              :disabled="!dirty"
              :loading="saving"
              @click="saveItems"
            >
              {{ $t('playlists.saveChanges') }}
            </UButton>
          </div>

          <EmptyState
            v-if="drafts.length === 0"
            class="mt-4"
            icon="i-lucide-list-music"
            :title="$t('playlists.emptyPlaylistTitle')"
            :description="$t('playlists.emptyPlaylistDescription')"
          />
          <ul v-else class="mt-4 space-y-2">
            <PlaylistItemRow
              v-for="(item, i) in drafts"
              :key="item.id ?? `new-${i}`"
              :item="item"
              :index="i"
              :total="drafts.length"
              :media="mediaFor(item.mediaId)"
              @move="(delta) => move(i, delta)"
              @remove="removeItem(i)"
              @update:duration="(ms) => updateDuration(i, ms)"
            />
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
