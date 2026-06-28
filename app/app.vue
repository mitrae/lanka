<script setup lang="ts">
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAuthStore } from '~/app/stores/auth'
import { useDevicesStore } from '~/app/stores/devices'
import {
  useDashboardStream,
  _resetDashboardStream,
  shouldOpenDashboardStream
} from '~/app/composables/useDashboardStream'
import { uk } from '@nuxt/ui/locale'

useHead({
  title: 'Lanka',
  link: [{ rel: 'icon', href: '/favicon.ico' }]
})

if (import.meta.client) {
  const route = useRoute()
  const auth = useAuthStore()
  const { isAuthenticated, role } = storeToRefs(auth)
  const devicesStore = useDevicesStore()
  let unsubscribe: (() => void) | null = null

  watch(
    () => [isAuthenticated.value, role.value, route.path] as const,
    ([authed, r, path]) => {
      if (shouldOpenDashboardStream({ authenticated: authed, role: r, path })) {
        // Open (or reuse) the singleton stream only for an authenticated
        // admin/super on a dashboard route — never for a client (/portal),
        // /player, or the public auth pages.
        const stream = useDashboardStream()
        if (!unsubscribe) {
          unsubscribe = stream.onDeviceEvent((p) =>
            devicesStore.applyDeviceEvent(p)
          )
        }
      } else if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
        _resetDashboardStream()
      }
    },
    { immediate: true }
  )
}
</script>

<template>
  <UApp :locale="uk">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
