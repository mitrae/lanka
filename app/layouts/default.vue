<script setup lang="ts">
const route = useRoute()
const auth = useAuthStore()

const navItems = [
  { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: 'Addresses', icon: 'i-lucide-building-2', to: '/addresses' },
  { label: 'Groups', icon: 'i-lucide-folder', to: '/groups' },
  { label: 'Devices', icon: 'i-lucide-tv', to: '/devices' },
  { label: 'Media', icon: 'i-lucide-image', to: '/media' },
  { label: 'Playlists', icon: 'i-lucide-list-music', to: '/playlists' },
  { label: 'Organizations', icon: 'i-lucide-briefcase', to: '/organizations' }
]

const stream = import.meta.client ? useDashboardStream() : null
const streamState = computed(() => (stream ? stream.state.value : ('connecting' as const)))

const colorMode = useColorMode()
function toggleDark() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
async function signOut() {
  await auth.logout()
  await navigateTo('/login')
}
function isActive(to: string) {
  return route.path === to || (to !== '/' && route.path.startsWith(to))
}
</script>

<template>
  <div class="app-bg flex h-screen">
    <aside class="flex w-64 flex-col px-3 py-4">
      <div class="flex h-12 items-center gap-2 px-3">
        <UIcon name="i-lucide-radio-tower" class="size-6 text-black" />
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
      </div>

      <nav class="mt-4 flex-1 space-y-1">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors"
          :class="isActive(item.to)
            ? 'bg-black text-white shadow-sm'
            : 'text-(--ui-text-muted) hover:bg-black/5 hover:text-(--ui-text)'"
        >
          <UIcon :name="item.icon" class="size-4" />
          {{ item.label }}
        </NuxtLink>
      </nav>

      <div class="space-y-3 px-1">
        <div class="flex items-center gap-2 px-2 text-xs text-(--ui-text-muted)">
          <span
            class="size-2 rounded-full"
            :class="{
              'bg-emerald-500': streamState === 'connected',
              'bg-amber-500': streamState === 'connecting',
              'bg-rose-500': streamState === 'disconnected'
            }"
          />
          <span class="capitalize">{{ streamState }}</span>
        </div>
        <div class="flex items-center justify-between rounded-2xl bg-white/70 px-3 py-2 shadow-sm">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ auth.user?.username }}</p>
            <p class="text-xs capitalize text-(--ui-text-muted)">{{ auth.role }}</p>
          </div>
          <div class="flex items-center">
            <UButton
              variant="ghost" color="neutral" size="sm"
              :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
              :aria-label="`Switch to ${colorMode.value === 'dark' ? 'light' : 'dark'} mode`"
              @click="toggleDark"
            />
            <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-log-out" aria-label="Sign out" @click="signOut" />
          </div>
        </div>
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto">
      <div class="px-8 py-8">
        <slot />
      </div>
    </main>
  </div>
</template>
