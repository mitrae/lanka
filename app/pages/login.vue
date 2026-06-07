<script setup lang="ts">
definePageMeta({ layout: false })
const auth = useAuthStore()
const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

async function submit() {
  error.value = null
  loading.value = true
  try {
    const user = await auth.login(username.value, password.value)
    await navigateTo(user.role === 'client' ? '/portal' : '/')
  } catch {
    error.value = 'Invalid username or password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-bg flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-sm rounded-3xl border border-black/5 bg-white/80 p-8 shadow-xl backdrop-blur">
      <div class="mb-6 flex items-center gap-2">
        <UIcon name="i-lucide-radio-tower" class="size-6 text-black" />
        <span class="text-xl font-semibold tracking-tight">Lanka</span>
      </div>
      <h1 class="mb-1 text-2xl font-bold tracking-tight">Sign in</h1>
      <p class="mb-6 text-sm text-(--ui-text-muted)">Manage your signage network.</p>

      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="Username">
          <UInput v-model="username" name="username" autocomplete="username" size="lg" class="w-full" />
        </UFormField>
        <UFormField label="Password">
          <UInput v-model="password" type="password" name="password" autocomplete="current-password" size="lg" class="w-full" />
        </UFormField>
        <p v-if="error" class="text-sm text-rose-500">{{ error }}</p>
        <UButton
          type="submit"
          block
          size="lg"
          color="neutral"
          :loading="loading"
          class="rounded-xl"
        >
          Sign in
        </UButton>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-bg {
  background:
    radial-gradient(1200px 600px at 20% -10%, rgba(124, 138, 255, 0.18), transparent 60%),
    radial-gradient(900px 500px at 90% 10%, rgba(255, 120, 120, 0.12), transparent 55%),
    linear-gradient(180deg, #f3f4fb 0%, #ffffff 100%);
}
</style>
