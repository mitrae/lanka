<script setup lang="ts">
const auth = useAuthStore()
const colorMode = useColorMode()
function toggleDark() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
async function signOut() {
  await auth.logout()
  await navigateTo('/login')
}
</script>

<template>
  <div class="app-bg min-h-screen">
    <header class="flex h-16 items-center justify-between border-b border-(--rail-border) px-6 sm:px-10">
      <div class="flex items-center gap-2.5">
        <span class="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
          <UIcon name="i-lucide-radio-tower" class="size-5" />
        </span>
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
        <span class="ml-1 rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">Client</span>
      </div>
      <div class="flex items-center gap-2 text-sm text-(--ui-text-muted)">
        <span>{{ auth.user?.email }}</span>
        <UButton
          variant="ghost" color="neutral" size="sm"
          :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
          :aria-label="`Switch to ${colorMode.value === 'dark' ? 'light' : 'dark'} mode`"
          @click="toggleDark"
        />
        <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-log-out" aria-label="Sign out" @click="signOut" />
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-6 pb-16 sm:px-10">
      <slot />
    </main>
  </div>
</template>
