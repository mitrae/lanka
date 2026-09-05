<script setup lang="ts">
import { usePlaylistsStore } from '~/app/stores/playlists'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const store = usePlaylistsStore()
const toast = useToast()
const creating = ref(false)
const newName = ref('')

onMounted(() => store.refresh())

async function createPlaylist() {
  if (!newName.value.trim()) return
  try {
    const p = await store.create({ name: newName.value.trim() })
    newName.value = ''
    creating.value = false
    toast.add({ title: t('playlists.created'), color: 'success' })
    navigateTo(`/playlists/${p.id}`)
  } catch (err: any) {
    toast.add({
      title: t('playlists.createFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('playlists.pageTitle')"
      :subtitle="$t('playlists.pageSubtitle')"
      icon="i-lucide-list-music"
    >
      <template #actions>
        <UButton
          v-if="!creating"
          color="primary"
          icon="i-lucide-plus"
          @click="creating = true"
        >
          {{ $t('playlists.newPlaylist') }}
        </UButton>
      </template>
    </PageHeader>

    <div
      v-if="creating"
      class="soft-card mb-4 flex flex-col gap-2 p-4 sm:flex-row sm:items-center"
    >
      <UInput
        v-model="newName"
        :placeholder="$t('playlists.namePlaceholder')"
        class="w-full sm:max-w-md sm:flex-1"
        autofocus
        @keyup.enter="createPlaylist"
      />
      <UButton color="primary" @click="createPlaylist">{{ $t('playlists.createAndEdit') }}</UButton>
      <UButton
        variant="ghost"
        color="neutral"
        @click="creating = false; newName = ''"
      >
        {{ $t('common.cancel') }}
      </UButton>
    </div>

    <USkeleton v-if="store.loading && store.list.length === 0" class="h-24 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      icon="i-lucide-list-music"
      :title="$t('playlists.emptyTitle')"
      :description="$t('playlists.emptyDescription')"
    >
      <UButton color="primary" icon="i-lucide-plus" @click="creating = true">
        {{ $t('playlists.createPlaylist') }}
      </UButton>
    </EmptyState>
    <ul v-else class="space-y-2.5">
      <li
        v-for="p in store.list"
        :key="p.id"
        class="soft-card hover-lift"
      >
        <NuxtLink :to="`/playlists/${p.id}`" class="flex items-center gap-3.5 p-4">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <UIcon name="i-lucide-list-music" class="size-5" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-(--ui-text-highlighted)">{{ p.name }}</p>
            <p class="text-xs text-(--ui-text-muted)">
              {{ $t('playlists.itemCount', p.itemCount, { n: p.itemCount }) }}
              · {{ $t('playlists.assignmentCount', p.assignmentCount, { n: p.assignmentCount }) }}
              · <span class="font-mono">{{ $t('playlists.version', { n: p.version }) }}</span>
            </p>
          </div>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed)" />
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
