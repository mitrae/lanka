<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useDashboardStream } from '~/app/composables/useDashboardStream'

useHead({
  title: 'Lanka',
  link: [{ rel: 'icon', href: '/favicon.ico' }]
})

onMounted(() => {
  if (import.meta.client) {
    const stream = useDashboardStream()
    const devicesStore = useDevicesStore()
    stream.onDeviceEvent((p) => devicesStore.applyDeviceEvent(p))
  }
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
