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
  <div>
    <div class="flex items-center justify-between">
      <p class="text-sm text-(--ui-text-muted)">
        Ordered lists of media that TVs loop. Assign a playlist to a device, group, or address.
      </p>
      <UButton
        v-if="!creating"
        color="primary"
        icon="i-lucide-plus"
        @click="creating = true"
      >
        New playlist
      </UButton>
    </div>

    <div
      v-if="creating"
      class="mt-4 flex items-center gap-2 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
    >
      <UInput
        v-model="newName"
        placeholder="Playlist name (e.g. Summer Promo)"
        class="flex-1 max-w-md"
        autofocus
        @keyup.enter="createPlaylist"
      />
      <UButton color="primary" @click="createPlaylist">Create & edit</UButton>
      <UButton
        variant="ghost"
        @click="creating = false; newName = ''"
      >
        Cancel
      </UButton>
    </div>

    <USkeleton v-if="store.loading && store.list.length === 0" class="mt-6 h-24 w-full" />
    <EmptyState
      v-else-if="store.list.length === 0"
      class="mt-6"
      icon="i-lucide-list-music"
      title="No playlists yet"
      description="Create a playlist and add media items to it."
    >
      <UButton
        color="primary"
        icon="i-lucide-plus"
        @click="creating = true"
      >
        Create playlist
      </UButton>
    </EmptyState>
    <ul v-else class="mt-6 space-y-2">
      <li
        v-for="p in store.list"
        :key="p.id"
        class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4 hover:border-(--ui-border-accented) transition-colors"
      >
        <NuxtLink :to="`/playlists/${p.id}`" class="flex-1 flex items-center gap-3">
          <UIcon name="i-lucide-list-music" class="size-5 text-(--ui-text-muted)" />
          <div>
            <p class="font-medium">{{ p.name }}</p>
            <p class="text-xs text-(--ui-text-muted)">
              {{ p.itemCount }} item{{ p.itemCount === 1 ? '' : 's' }}
              · {{ p.assignmentCount }} assignment{{ p.assignmentCount === 1 ? '' : 's' }}
              · v{{ p.version }}
            </p>
          </div>
        </NuxtLink>
        <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
      </li>
    </ul>
  </div>
</template>
