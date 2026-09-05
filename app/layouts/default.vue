<script setup lang="ts">
const route = useRoute()

const stream = import.meta.client ? useDashboardStream() : null
const streamState = computed(() => (stream ? stream.state.value : ('connecting' as const)))

// Off-canvas nav, phones and small tablets only. The `lg:` sidebar below is a
// separate mount of the same component; only one is ever visible.
const navOpen = ref(false)
watch(() => route.path, () => { navOpen.value = false })

// The dialog autofocuses its first focusable child, which lands a hard focus
// ring on the first nav link every time the drawer opens. Focus the panel
// itself instead: the focus trap is preserved, the stray ring is not.
const navPanel = useTemplateRef<HTMLElement>('navPanel')
function focusPanel(e: Event) {
  e.preventDefault()
  navPanel.value?.focus()
}
</script>

<template>
  <div class="app-bg flex min-h-dvh lg:h-screen">
    <aside class="hidden w-64 shrink-0 flex-col border-r border-(--rail-border) bg-(--rail-bg) backdrop-blur-xl lg:flex">
      <AppNav :stream-state="streamState" />
    </aside>

    <!-- The page scrolls the document on phones; only the `lg:` shell pins the
         viewport and gives `main` its own scroll container. -->
    <main class="min-w-0 flex-1 lg:overflow-y-auto">
      <!-- mobile chrome -->
      <div
        class="safe-t sticky top-0 z-30 border-b border-(--rail-border) bg-(--rail-bg) backdrop-blur-xl lg:hidden"
      >
        <div class="flex h-14 items-center gap-2 px-3">
          <UButton
            variant="ghost" color="neutral"
            class="size-10 shrink-0 justify-center"
            icon="i-lucide-menu"
            :aria-label="$t('nav.openMenu')"
            @click="navOpen = true"
          />
          <span class="flex size-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
            <UIcon name="i-lucide-radio-tower" class="size-4" />
          </span>
          <span class="text-base font-semibold tracking-tight">Lanka</span>
          <span
            class="ml-auto size-2 shrink-0 rounded-full"
            :class="{
              'bg-emerald-500': streamState === 'connected',
              'bg-amber-500': streamState === 'connecting',
              'bg-rose-500': streamState === 'disconnected'
            }"
            :aria-label="$t('nav.realtime')"
          />
        </div>
      </div>

      <div class="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        <slot />
      </div>
    </main>

    <USlideover
      v-model:open="navOpen"
      side="left"
      :ui="{ content: 'w-72 max-w-[85vw]' }"
      :content="{ onOpenAutoFocus: focusPanel }"
    >
      <template #content>
        <div ref="navPanel" class="safe-t app-bg h-full outline-none" tabindex="-1">
          <AppNav :stream-state="streamState" @navigate="navOpen = false" />
        </div>
      </template>
    </USlideover>
  </div>
</template>
