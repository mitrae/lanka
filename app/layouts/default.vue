<script setup lang="ts">
const route = useRoute()

const navItems = [
  { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: 'Addresses', icon: 'i-lucide-building-2', to: '/addresses' },
  { label: 'Groups', icon: 'i-lucide-folder', to: '/groups' },
  { label: 'Devices', icon: 'i-lucide-tv', to: '/devices' },
  { label: 'Media', icon: 'i-lucide-image', to: '/media' },
  { label: 'Playlists', icon: 'i-lucide-list-music', to: '/playlists' }
]

const stream = import.meta.client ? useDashboardStream() : null
const streamState = computed(() =>
  stream ? stream.state.value : ('connecting' as const)
)

const colorMode = useColorMode()
function toggleDark() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>

<template>
  <div class="flex h-screen bg-(--ui-bg) text-(--ui-text)">
    <aside
      class="flex w-60 flex-col border-r border-(--ui-border) bg-(--ui-bg-elevated)"
    >
      <div class="flex h-16 items-center gap-2 px-6">
        <UIcon name="i-lucide-radio-tower" class="text-primary size-6" />
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
      </div>
      <nav class="flex-1 px-3 py-2 space-y-1">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
          :class="{
            'bg-(--ui-bg-accented) text-(--ui-text-highlighted)':
              route.path === item.to ||
              (item.to !== '/' && route.path.startsWith(item.to)),
            'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)':
              route.path !== item.to &&
              (item.to === '/' || !route.path.startsWith(item.to))
          }"
        >
          <UIcon :name="item.icon" class="size-4" />
          {{ item.label }}
        </NuxtLink>
      </nav>
      <div class="border-t border-(--ui-border) p-3">
        <div class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
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
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto">
      <header class="flex h-16 items-center justify-between border-b border-(--ui-border) px-6">
        <h1 class="text-sm font-medium text-(--ui-text-muted)">
          <slot name="header" />
        </h1>
        <UButton
          variant="ghost"
          color="neutral"
          size="sm"
          :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
          :aria-label="`Switch to ${colorMode.value === 'dark' ? 'light' : 'dark'} mode`"
          @click="toggleDark"
        />
      </header>
      <div class="p-8">
        <slot />
      </div>
    </main>
  </div>
</template>
