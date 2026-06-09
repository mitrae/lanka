<script setup lang="ts">
definePageMeta({ layout: false })
const { t } = useI18n()
const api = useApiClient()
const email = ref('')
const sent = ref(false)
const loading = ref(false)

async function submit() {
  if (loading.value) return
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
      <template v-if="!sent">
        <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">{{ $t('auth.forgotTitle') }}</h1>
        <p class="mt-2 text-sm text-(--ui-text-muted)">{{ $t('auth.forgotSubtitle') }}</p>
        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField :label="$t('auth.emailLabel')">
            <UInput v-model="email" type="email" name="email" autocomplete="username" size="lg" icon="i-lucide-mail" placeholder="you@company.com" class="w-full" />
          </UFormField>
          <UButton type="submit" block size="lg" color="primary" :loading="loading">{{ $t('auth.sendResetLink') }}</UButton>
        </form>
      </template>
      <template v-else>
        <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">{{ $t('auth.checkInboxTitle') }}</h1>
        <i18n-t keypath="auth.forgotSent" tag="p" class="mt-2 text-sm text-(--ui-text-muted)">
          <template #email>
            <span class="font-medium text-(--ui-text)">{{ email }}</span>
          </template>
        </i18n-t>
      </template>
      <NuxtLink to="/login" class="mt-8 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">{{ $t('auth.backToSignIn') }}</NuxtLink>
    </div>
  </div>
</template>
