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
  await Promise.all([devicesStore.refresh(), mediaStore.refresh(), playlistsStore.refresh()])
})

const stats = computed(() => {
  const total = devicesStore.list.length
  const online = devicesStore.list.filter((d) => d.status === 'online').length
  const offlineLong = devicesStore.list.filter((d) => d.status === 'offline' && d.groupId !== null).length
  const unclaimed = devicesStore.list.filter((d) => d.groupId === null).length
  return { total, online, offlineLong, unclaimed }
})
</script>

<template>
  <div class="reveal">
    <PageHeader
      title="Overview"
      subtitle="Your signage network at a glance."
      icon="i-lucide-layout-dashboard"
    />

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <StatCard label="Total devices" :value="stats.total" icon="i-lucide-tv" />
      <StatCard label="Online now" :value="stats.online" icon="i-lucide-wifi" tone="emerald" />
      <StatCard label="Offline > 5 min" :value="stats.offlineLong" icon="i-lucide-wifi-off" tone="rose" />
      <StatCard label="Unclaimed" :value="stats.unclaimed" icon="i-lucide-inbox" tone="amber" />
    </div>

    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div class="soft-card flex items-center justify-center p-6">
        <Donut :value="stats.online" :total="stats.total" label="Screens online" color="#22c55e" />
      </div>
      <div class="lg:col-span-2">
        <UnclaimedDevicesTray />
      </div>
    </div>

    <div class="mt-6">
      <ErrorFeed />
    </div>
  </div>
</template>
