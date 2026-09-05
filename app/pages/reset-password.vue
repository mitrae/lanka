<script setup lang="ts">
definePageMeta({ layout: false })
const { t } = useI18n()
const api = useApiClient()
const route = useRoute()
const token = computed(() => String(route.query.token ?? ''))
const tokenMissing = computed(() => !token.value)
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)
const done = ref(false)

let redirectTimer: ReturnType<typeof setTimeout> | null = null

async function submit() {
  error.value = null
  if (password.value.length < 8) {
    error.value = t('auth.passwordTooShort')
    return
  }
  loading.value = true
  try {
    await api.resetPassword({ token: token.value, password: password.value })
    done.value = true
    redirectTimer = setTimeout(() => navigateTo('/login'), 1500)
  } catch {
    error.value = t('auth.resetLinkInvalid')
  } finally {
    loading.value = false
  }
}

onUnmounted(() => {
  if (redirectTimer) clearTimeout(redirectTimer)
})
</script>

<template>
  <div class="canvas-bg flex min-h-dvh items-center justify-center px-5 py-8 sm:p-8">
    <div class="reveal w-full max-w-sm">
      <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">{{ $t('auth.resetTitle') }}</h1>
      <p v-if="done" class="mt-2 text-sm text-(--ui-text-muted)">{{ $t('auth.passwordUpdated') }}</p>
      <template v-else-if="tokenMissing">
        <p class="mt-2 text-sm text-(--ui-text-muted)">{{ $t('auth.resetLinkMissing') }}</p>
        <NuxtLink to="/forgot-password" class="mt-6 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">{{ $t('auth.requestNewLink') }}</NuxtLink>
      </template>
      <template v-else>
        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField :label="$t('auth.newPasswordLabel')">
            <UInput v-model="password" type="password" name="new-password" autocomplete="new-password" size="lg" icon="i-lucide-lock" :placeholder="$t('auth.newPasswordPlaceholder')" class="w-full" />
          </UFormField>
          <div v-if="error" class="flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2.5 text-sm font-medium text-rose-600 dark:text-rose-400">
            <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" /><span>{{ error }}</span>
          </div>
          <UButton type="submit" block size="lg" color="primary" :loading="loading">{{ $t('auth.updatePassword') }}</UButton>
        </form>
        <NuxtLink to="/forgot-password" class="mt-6 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">{{ $t('auth.requestNewLink') }}</NuxtLink>
      </template>
    </div>
  </div>
</template>
