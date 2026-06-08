<script setup lang="ts">
const route = useRoute()
const auth = useAuthStore()

const navGroups = [
  {
    items: [{ label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' }]
  },
  {
    label: 'Network',
    items: [
      { label: 'Addresses', icon: 'i-lucide-building-2', to: '/addresses' },
      { label: 'Groups', icon: 'i-lucide-folder', to: '/groups' },
      { label: 'Devices', icon: 'i-lucide-tv', to: '/devices' }
    ]
  },
  {
    label: 'Content',
    items: [
      { label: 'Media', icon: 'i-lucide-image', to: '/media' },
      { label: 'Playlists', icon: 'i-lucide-list-music', to: '/playlists' }
    ]
  },
  {
    label: 'People',
    items: [
      { label: 'Users', icon: 'i-lucide-users', to: '/users' },
      { label: 'Organizations', icon: 'i-lucide-briefcase', to: '/organizations' }
    ]
  }
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

const initials = computed(() => (auth.user?.email ?? '?').slice(0, 2).toUpperCase())
</script>

<template>
  <div class="app-bg flex h-screen">
    <aside class="flex w-64 shrink-0 flex-col border-r border-(--rail-border) bg-(--rail-bg) backdrop-blur-xl">
      <!-- brand -->
      <div class="flex h-16 items-center gap-2.5 px-5">
        <span class="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
          <UIcon name="i-lucide-radio-tower" class="size-5" />
        </span>
        <div class="leading-tight">
          <p class="text-base font-semibold tracking-tight">Lanka</p>
          <p class="text-[11px] text-(--ui-text-muted)">Signage control</p>
        </div>
      </div>

      <!-- grouped nav -->
      <nav class="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        <div v-for="(group, gi) in navGroups" :key="gi" class="space-y-0.5">
          <p
            v-if="group.label"
            class="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-(--ui-text-dimmed)"
          >
            {{ group.label }}
          </p>
          <NuxtLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors"
            :class="isActive(item.to)
              ? 'bg-indigo-500/10 font-medium text-indigo-700 ring-1 ring-indigo-500/15 dark:text-indigo-300'
              : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
          >
            <UIcon
              :name="item.icon"
              class="size-4 transition-colors"
              :class="isActive(item.to) ? 'text-indigo-600 dark:text-indigo-400' : 'text-(--ui-text-dimmed) group-hover:text-(--ui-text-muted)'"
            />
            {{ item.label }}
          </NuxtLink>
        </div>
      </nav>

      <!-- system-status footer -->
      <div class="space-y-2 border-t border-(--rail-border) p-3">
        <div class="flex items-center gap-2 px-2 py-1 text-xs">
          <span class="relative flex size-2">
            <span
              v-if="streamState === 'connected'"
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"
            />
            <span
              class="relative inline-flex size-2 rounded-full"
              :class="{
                'bg-emerald-500': streamState === 'connected',
                'bg-amber-500': streamState === 'connecting',
                'bg-rose-500': streamState === 'disconnected'
              }"
            />
          </span>
          <span class="text-(--ui-text-muted)">Realtime</span>
          <span
            class="ml-auto font-medium capitalize"
            :class="{
              'text-emerald-600 dark:text-emerald-400': streamState === 'connected',
              'text-amber-600 dark:text-amber-400': streamState === 'connecting',
              'text-rose-500': streamState === 'disconnected'
            }"
          >{{ streamState }}</span>
        </div>

        <div class="soft-card flex items-center gap-2.5 p-2.5">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-xs font-semibold text-indigo-600 dark:text-indigo-300">
            {{ initials }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium leading-tight">{{ auth.user?.email }}</p>
            <p class="text-xs capitalize text-(--ui-text-muted)">{{ auth.role }}</p>
          </div>
          <UButton
            variant="ghost" color="neutral" size="sm"
            :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
            :aria-label="`Switch to ${colorMode.value === 'dark' ? 'light' : 'dark'} mode`"
            @click="toggleDark"
          />
          <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-log-out" aria-label="Sign out" @click="signOut" />
        </div>
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-7xl px-8 py-8">
        <slot />
      </div>
    </main>
  </div>
</template>
