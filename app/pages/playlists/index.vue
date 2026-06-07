<script setup lang="ts">
import { usePlaylistsStore } from '~/app/stores/playlists'

definePageMeta({ layout: 'default' })

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
    toast.add({ title: 'Playlist created', color: 'success' })
    navigateTo(`/playlists/${p.id}`)
  } catch (err: any) {
    toast.add({
      title: 'Create failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      title="Playlists"
      subtitle="Ordered lists of media that TVs loop. Assign to a device, group, or address."
      icon="i-lucide-list-music"
    >
      <template #actions>
        <UButton
          v-if="!creating"
          color="primary"
          icon="i-lucide-plus"
          @click="creating = true"
        >
          New playlist
        </UButton>
      </template>
    </PageHeader>

    <div
      v-if="creating"
      class="soft-card mb-4 flex items-center gap-2 p-4"
    >
      <UInput
        v-model="newName"
        placeholder="Playlist name (e.g. Summer Promo)"
        class="max-w-md flex-1"
        autofocus
        @keyup.enter="createPlaylist"
      />
      <UButton color="primary" @click="createPlaylist">Create & edit</UButton>
      <UButton
        variant="ghost"
        color="neutral"
        @click="creating = false; newName = ''"
      >
        Cancel
      </UButton>
    </div>

    <USkeleton v-if="store.loading && store.list.length === 0" class="h-24 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      icon="i-lucide-list-music"
      title="No playlists yet"
      description="Create a playlist and add media items to it."
    >
      <UButton color="primary" icon="i-lucide-plus" @click="creating = true">
        Create playlist
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
            <p class="font-medium text-(--ui-text-highlighted)">{{ p.name }}</p>
            <p class="text-xs text-(--ui-text-muted)">
              {{ p.itemCount }} item{{ p.itemCount === 1 ? '' : 's' }}
              · {{ p.assignmentCount }} assignment{{ p.assignmentCount === 1 ? '' : 's' }}
              · <span class="font-mono">v{{ p.version }}</span>
            </p>
          </div>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed)" />
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
