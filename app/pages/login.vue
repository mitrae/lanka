<script setup lang="ts">
definePageMeta({ layout: false })
const auth = useAuthStore()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

const config = useRuntimeConfig()
const googleClientId = (config.public.googleClientId as string) || ''
const googleBtn = ref<HTMLElement | null>(null)

async function submit() {
  error.value = null
  loading.value = true
  try {
    const user = await auth.login(email.value, password.value)
    await navigateTo(user.role === 'client' ? '/portal' : '/')
  } catch {
    error.value = 'Invalid email or password'
  } finally {
    loading.value = false
  }
}

function loadGisScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as any
    if (w.google?.accounts?.id) return resolve()
    const existing = document.getElementById('gis-client')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('gis load failed')), { once: true })
      return
    }
    const s = document.createElement('script')
    s.id = 'gis-client'
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('gis load failed'))
    document.head.appendChild(s)
  })
}

async function handleGoogleCredential(response: { credential: string }) {
  error.value = null
  loading.value = true
  try {
    const user = await auth.loginWithGoogle(response.credential)
    await navigateTo(user.role === 'client' ? '/portal' : '/')
  } catch {
    error.value = 'Google sign-in failed, or no Lanka account for that address'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!googleClientId) return
  try {
    await loadGisScript()
    if (!googleBtn.value) return // component unmounted during script load
    const w = window as any
    w.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential
    })
    w.google.accounts.id.renderButton(googleBtn.value, {
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'signin_with'
    })
  } catch {
    // Script blocked or origin not authorized — button just won't appear.
    // Password login is unaffected.
  }
})
</script>

<template>
  <div class="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
    <!-- Left: broadcast signal panel -->
    <aside class="signal-panel grain relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex">
      <!-- concentric signal geometry -->
      <div aria-hidden="true" class="absolute inset-0">
        <div class="signal-ring" style="width: 210px; height: 210px" />
        <div class="signal-ring" style="width: 400px; height: 400px" />
        <div class="signal-ring" style="width: 610px; height: 610px" />
        <div class="signal-ring" style="width: 840px; height: 840px" />
        <div class="signal-ping" style="animation-delay: 0s" />
        <div class="signal-ping" style="animation-delay: 1.7s" />
        <div class="signal-ping" style="animation-delay: 3.4s" />
      </div>

      <!-- tower mark at the ring origin -->
      <div
        aria-hidden="true"
        class="absolute left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur"
        style="top: 34%"
      >
        <UIcon name="i-lucide-radio-tower" class="size-8 text-indigo-100" />
      </div>

      <!-- brand -->
      <div class="relative flex items-center gap-2.5">
        <span class="flex size-9 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
          <UIcon name="i-lucide-radio-tower" class="size-5" />
        </span>
        <span class="text-lg font-semibold tracking-tight">Lanka</span>
      </div>

      <!-- hero copy + trust footer -->
      <div class="relative space-y-10">
        <div class="max-w-sm">
          <h2 class="text-4xl font-bold leading-[1.1] tracking-tight">
            Your screens,<br >one calm console.
          </h2>
          <p class="mt-4 text-sm leading-relaxed text-indigo-200/80">
            Monitor, group, and program every display across your network — from one quiet control plane.
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs font-medium text-indigo-200/70">
          <UIcon name="i-lucide-shield-check" class="size-4" />
          <span>Self-hosted · Tailscale-secured</span>
        </div>
      </div>
    </aside>

    <!-- Right: sign-in form -->
    <section class="canvas-bg flex items-center justify-center p-8">
      <div class="reveal w-full max-w-sm">
        <!-- compact brand for narrow viewports where the panel is hidden -->
        <div class="mb-8 flex items-center gap-2.5 lg:hidden">
          <UIcon name="i-lucide-radio-tower" class="size-6 text-indigo-600 dark:text-indigo-400" />
          <span class="text-xl font-semibold tracking-tight">Lanka</span>
        </div>

        <h1 class="text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">Sign in</h1>
        <p class="mt-2 text-sm text-(--ui-text-muted)">
          Welcome back. Enter your credentials to reach the console.
        </p>

        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <UFormField label="Email">
            <UInput
              v-model="email"
              name="email"
              type="email"
              autocomplete="username"
              size="lg"
              icon="i-lucide-mail"
              placeholder="you@company.com"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Password">
            <UInput
              v-model="password"
              type="password"
              name="password"
              autocomplete="current-password"
              size="lg"
              icon="i-lucide-lock"
              placeholder="••••••••"
              class="w-full"
            />
          </UFormField>

          <div class="flex justify-end">
            <NuxtLink to="/forgot-password" class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Forgot password?</NuxtLink>
          </div>

          <div
            v-if="error"
            class="flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2.5 text-sm font-medium text-rose-600 dark:text-rose-400"
          >
            <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" />
            <span>{{ error }}</span>
          </div>

          <UButton
            type="submit"
            block
            size="lg"
            color="primary"
            :loading="loading"
            trailing-icon="i-lucide-arrow-right"
            class="mt-2"
          >
            Sign in
          </UButton>
        </form>

        <template v-if="googleClientId">
          <div class="my-6 flex items-center gap-3 text-xs font-medium text-(--ui-text-dimmed)">
            <span class="h-px flex-1 bg-(--ui-border)" />
            <span>or</span>
            <span class="h-px flex-1 bg-(--ui-border)" />
          </div>
          <div ref="googleBtn" class="flex justify-center" />
        </template>

        <p class="mt-10 text-xs leading-relaxed text-(--ui-text-dimmed)">
          Lanka signage control plane · access is provisioned by your administrator.
        </p>
      </div>
    </section>
  </div>
</template>
