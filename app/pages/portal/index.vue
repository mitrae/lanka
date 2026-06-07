<script setup lang="ts">
import type { OrgReach } from '~/app/types/api'
definePageMeta({ layout: 'portal' })

const api = useApiClient()
const stats = ref<OrgReach | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    stats.value = await api.getPortalStats()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load stats'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="pt-4">
    <h1 class="mb-1 text-3xl font-bold tracking-tight">
      {{ stats?.organization.name ?? 'Your stats' }}
    </h1>
    <p class="mb-8 text-sm text-(--ui-text-muted)">Reach of your content across the network.</p>

    <p v-if="loading" class="text-(--ui-text-muted)">Loading…</p>
    <p v-else-if="error" class="text-rose-500">{{ error }}</p>

    <template v-else-if="stats">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Media items" :value="stats.totals.mediaCount" icon="i-lucide-image" />
        <StatCard label="Screens reached" :value="stats.totals.screensReached" icon="i-lucide-tv" tone="blue" />
        <StatCard label="Online now" :value="stats.totals.screensOnline" icon="i-lucide-wifi" tone="emerald" />
        <StatCard label="Showing now" :value="stats.totals.showingNow" icon="i-lucide-play" tone="amber" />
      </div>

      <div class="mt-8 overflow-hidden rounded-3xl border border-black/5 bg-white/80 shadow-sm">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase tracking-wide text-(--ui-text-muted)">
            <tr class="border-b border-black/5">
              <th class="px-5 py-3 font-medium">Media</th>
              <th class="px-5 py-3 font-medium tabular-nums">Scheduled</th>
              <th class="px-5 py-3 font-medium tabular-nums">Online</th>
              <th class="px-5 py-3 font-medium tabular-nums">Showing now</th>
              <th class="px-5 py-3 font-medium tabular-nums">Errors</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in stats.media" :key="m.mediaId" class="border-b border-black/5 last:border-0">
              <td class="px-5 py-3">
                <span class="font-medium">{{ m.filename }}</span>
                <span class="ml-2 rounded-full bg-black/5 px-2 py-0.5 text-xs">{{ m.kind }}</span>
              </td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensScheduled }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensOnline }}</td>
              <td class="px-5 py-3 tabular-nums">{{ m.screensShowingNow }}</td>
              <td class="px-5 py-3 tabular-nums" :class="m.recentErrors ? 'text-rose-500' : ''">{{ m.recentErrors }}</td>
            </tr>
            <tr v-if="stats.media.length === 0">
              <td colspan="5" class="px-5 py-8 text-center text-(--ui-text-muted)">No media assigned to your organization yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
