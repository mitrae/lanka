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
  <div class="app-bg min-h-dvh">
    <header class="safe-t flex h-16 items-center justify-between gap-2 border-b border-(--rail-border) px-4 sm:px-10">
      <div class="flex min-w-0 items-center gap-2.5">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
          <UIcon name="i-lucide-radio-tower" class="size-5" />
        </span>
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
        <span class="ml-1 hidden rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-600 sm:inline dark:text-indigo-400">{{ $t('portal.clientBadge') }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1 text-sm text-(--ui-text-muted) sm:gap-2">
        <!-- The email is the least useful thing on a 390px bar; the account is
             already implied by what the page shows. -->
        <span class="hidden max-w-[40vw] truncate md:inline">{{ auth.user?.email }}</span>
        <UButton
          variant="ghost" color="neutral" size="sm"
          class="size-9 justify-center"
          :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
          :aria-label="colorMode.value === 'dark' ? $t('nav.switchToLight') : $t('nav.switchToDark')"
          @click="toggleDark"
        />
        <UButton variant="ghost" color="neutral" size="sm" class="size-9 justify-center" icon="i-lucide-log-out" :aria-label="$t('nav.signOut')" @click="signOut" />
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-4 pb-16 sm:px-10">
      <slot />
    </main>
  </div>
</template>
