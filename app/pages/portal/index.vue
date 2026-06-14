<script setup lang="ts">
import type { OrgReach } from '~/app/types/api'
definePageMeta({ layout: 'portal' })

const { t } = useI18n()
const api = useApiClient()
const stats = ref<OrgReach | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

let timer: ReturnType<typeof setInterval> | null = null

async function refresh() {
  try {
    stats.value = await api.getPortalStats()
    error.value = null
  } catch (e: any) {
    error.value = e?.message ?? t('portal.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 5000)
})

onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="reveal pt-4">
    <PageHeader
      :title="stats?.organization.name ?? $t('portal.yourStats')"
      :subtitle="$t('portal.subtitle')"
      icon="i-lucide-bar-chart-3"
    />

    <p v-if="loading" class="text-(--ui-text-muted)">{{ $t('common.loading') }}</p>
    <p v-else-if="error" class="text-rose-500">{{ error }}</p>

    <template v-else-if="stats">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard :label="$t('portal.statMediaItems')" :value="stats.totals.mediaCount" icon="i-lucide-image" />
        <StatCard :label="$t('portal.statScreensReached')" :value="stats.totals.screensReached" icon="i-lucide-tv" tone="blue" />
        <StatCard :label="$t('portal.statOnlineNow')" :value="stats.totals.screensOnline" icon="i-lucide-wifi" tone="emerald" />
        <StatCard :label="$t('portal.statShowingNow')" :value="stats.totals.showingNow" icon="i-lucide-play" tone="amber" />
      </div>

      <div class="soft-card mt-8 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase tracking-wide text-(--ui-text-muted)">
            <tr class="border-b border-(--ui-border)">
              <th class="px-5 py-3 font-medium">{{ $t('portal.colMedia') }}</th>
              <th class="px-5 py-3 font-medium tabular-nums">{{ $t('portal.colScheduled') }}</th>
              <th class="px-5 py-3 font-medium tabular-nums">{{ $t('portal.colOnline') }}</th>
              <th class="px-5 py-3 font-medium tabular-nums">{{ $t('portal.colShowingNow') }}</th>
              <th class="px-5 py-3 font-medium tabular-nums">{{ $t('portal.colErrors') }}</th>
              <th class="px-5 py-3 font-medium tabular-nums">{{ $t('portal.colPlays') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in stats.media" :key="m.mediaId" class="border-b border-(--ui-border) last:border-0">
              <td class="px-5 py-3">
                <span class="font-medium text-(--ui-text-highlighted)">{{ m.filename }}</span>
                <span class="ml-2 rounded-full bg-(--ui-bg-accented) px-2 py-0.5 text-xs text-(--ui-text-muted)">{{ m.kind === 'video' ? $t('components.playlistItemRow.video') : $t('components.playlistItemRow.image') }}</span>
              </td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensScheduled }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensOnline }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensShowingNow }}</td>
              <td class="px-5 py-3 tabular-nums" :class="m.recentErrors ? 'text-rose-500' : ''">{{ m.recentErrors }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.playCount }}</td>
            </tr>
            <tr v-if="stats.media.length === 0">
              <td colspan="6" class="px-5 py-8 text-center text-(--ui-text-muted)">{{ $t('portal.emptyMedia') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
