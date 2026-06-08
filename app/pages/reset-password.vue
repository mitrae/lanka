<script setup lang="ts">
definePageMeta({ layout: false })
const api = useApiClient()
const route = useRoute()
const token = computed(() => String(route.query.token ?? ''))
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)
const done = ref(false)

async function submit() {
  error.value = null
  if (password.value.length < 8) {
    error.value = 'Password must be at least 8 characters.'
    return
  }
  loading.value = true
  try {
    await api.resetPassword({ token: token.value, password: password.value })
    done.value = true
    setTimeout(() => navigateTo('/login'), 1500)
  } catch {
    error.value = 'This reset link is invalid or has expired. Request a new one.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="canvas-bg flex min-h-screen items-center justify-center p-8">
    <div class="reveal w-full max-w-sm">
      <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">Set a new password</h1>
      <template v-if="!done">
        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField label="New password">
            <UInput v-model="password" type="password" name="new-password" autocomplete="new-password" size="lg" icon="i-lucide-lock" placeholder="At least 8 characters" class="w-full" />
          </UFormField>
          <div v-if="error" class="flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2.5 text-sm font-medium text-rose-600 dark:text-rose-400">
            <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" /><span>{{ error }}</span>
          </div>
          <UButton type="submit" block size="lg" color="primary" :loading="loading">Update password</UButton>
        </form>
        <NuxtLink to="/forgot-password" class="mt-6 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">Request a new link</NuxtLink>
      </template>
      <p v-else class="mt-2 text-sm text-(--ui-text-muted)">Password updated. Redirecting to sign in…</p>
    </div>
  </div>
</template>
