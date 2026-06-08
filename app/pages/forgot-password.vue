<script setup lang="ts">
definePageMeta({ layout: false })
const api = useApiClient()
const email = ref('')
const sent = ref(false)
const loading = ref(false)

async function submit() {
  loading.value = true
  try {
    await api.forgotPassword({ email: email.value.trim() })
  } finally {
    loading.value = false
    sent.value = true // always show the same confirmation (anti-enumeration)
  }
}
</script>

<template>
  <div class="canvas-bg flex min-h-screen items-center justify-center p-8">
    <div class="reveal w-full max-w-sm">
      <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">Reset password</h1>
      <template v-if="!sent">
        <p class="mt-2 text-sm text-(--ui-text-muted)">Enter your email and we'll send a reset link.</p>
        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField label="Email">
            <UInput v-model="email" type="email" name="email" autocomplete="username" size="lg" icon="i-lucide-mail" placeholder="you@company.com" class="w-full" />
          </UFormField>
          <UButton type="submit" block size="lg" color="primary" :loading="loading">Send reset link</UButton>
        </form>
      </template>
      <p v-else class="mt-2 text-sm text-(--ui-text-muted)">
        If an account exists for <span class="font-medium text-(--ui-text)">{{ email }}</span>, a reset link is on its way. The link is valid for one hour.
      </p>
      <NuxtLink to="/login" class="mt-8 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">← Back to sign in</NuxtLink>
    </div>
  </div>
</template>
