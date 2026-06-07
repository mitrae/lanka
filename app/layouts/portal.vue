<script setup lang="ts">
const auth = useAuthStore()
async function signOut() {
  await auth.logout()
  await navigateTo('/login')
}
</script>

<template>
  <div class="app-bg min-h-screen">
    <header class="flex h-16 items-center justify-between px-6 sm:px-10">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-radio-tower" class="size-6 text-black" />
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
        <span class="ml-2 rounded-full bg-black px-2.5 py-0.5 text-xs font-medium text-white">Client</span>
      </div>
      <div class="flex items-center gap-3 text-sm text-(--ui-text-muted)">
        <span>{{ auth.user?.username }}</span>
        <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-log-out" @click="signOut" />
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-6 pb-16 sm:px-10">
      <slot />
    </main>
  </div>
</template>
