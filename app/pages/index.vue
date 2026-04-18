<!-- app/pages/index.vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useMediaStore } from '~/app/stores/media'
import { usePlaylistsStore } from '~/app/stores/playlists'

definePageMeta({ layout: 'default' })

const devicesStore = useDevicesStore()
const mediaStore = useMediaStore()
const playlistsStore = usePlaylistsStore()

onMounted(async () => {
  await Promise.all([
    devicesStore.refresh(),
    mediaStore.refresh(),
    playlistsStore.refresh()
  ])
})

const stats = computed(() => {
  const total = devicesStore.list.length
  const online = devicesStore.list.filter((d) => d.status === 'online').length
  const offlineLong = devicesStore.list.filter(
    (d) => d.status === 'offline' && d.groupId !== null
  ).length
  const unclaimed = devicesStore.list.filter((d) => d.groupId === null).length
  return { total, online, offlineLong, unclaimed }
})
</script>

<template>
  <div>
    <div class="grid grid-cols-4 gap-4">
      <StatCard
        label="Total devices"
        :value="stats.total"
        icon="i-lucide-tv"
      />
      <StatCard
        label="Online now"
        :value="stats.online"
        icon="i-lucide-wifi"
        tone="emerald"
      />
      <StatCard
        label="Offline > 5 min"
        :value="stats.offlineLong"
        icon="i-lucide-wifi-off"
        tone="rose"
      />
      <StatCard
        label="Unclaimed"
        :value="stats.unclaimed"
        icon="i-lucide-inbox"
        tone="amber"
      />
    </div>

    <div class="mt-8 grid grid-cols-2 gap-6">
      <UnclaimedDevicesTray />
      <ErrorFeed />
    </div>
  </div>
</template>
