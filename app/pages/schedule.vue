<!-- app/pages/schedule.vue -->
<!--
  The fleet-wide scheduled interrupt: one clip that pre-empts every playlist on
  every screen at a fixed time each day (Ukraine's 09:00 minute of silence).
  This is the only place a human configures it and the only place a human can
  tell, after the fact, whether every screen actually observed it.

  The status half (bottom card) is the half that matters: a screen that
  silently failed to interrupt is the failure this feature exists to catch, so
  it gets equal weight with the config form, not "decoration" treatment.
-->
<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { useMediaStore } from '~/app/stores/media'
import type { InterruptDeviceStatus, InterruptStatus } from '~/app/types/api'
import { deviceInterruptOutcome, type InterruptOutcome } from '~/app/utils/interruptStatus'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const api = useApiClient()
const toast = useToast()
const mediaStore = useMediaStore()

/** Matches the device poll cadence elsewhere in the dashboard. */
const STATUS_POLL_MS = 30_000

const status = ref<InterruptStatus | null>(null)
const loading = ref(true)
const saving = ref(false)
const refreshing = ref(false)

const mediaId = ref<number | null>(null)
const atMinutes = ref(9 * 60)
const enabled = ref(true)
const label = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null

// Restricted to videos inside the kiosk envelope: the server 400s an image
// and a `high` (1080p) clip alike, so the picker never offers either.
const videos = computed(() =>
  mediaStore.list.filter((m) => m.kind === 'video' && m.quality !== 'high')
)

/** `HH:MM` <-> minutes since local midnight, both directions. */
const timeString = computed({
  get: () => {
    const h = String(Math.floor(atMinutes.value / 60)).padStart(2, '0')
    const m = String(atMinutes.value % 60).padStart(2, '0')
    return `${h}:${m}`
  },
  set: (v: string) => {
    const [h, m] = v.split(':').map(Number)
    if (Number.isFinite(h) && Number.isFinite(m)) atMinutes.value = (h as number) * 60 + (m as number)
  }
})

/** The window's length is the clip's own length -- never a stored number. */
const durationSeconds = computed(() => {
  const clip = videos.value.find((v) => v.id === mediaId.value)
  return clip?.durationMs ? Math.round(clip.durationMs / 1000) : null
})

/** Kyiv-pinned, like every other judgment on this page. The browser's own
 *  zone would disagree with the read-only Europe/Kyiv time field above it. */
const nextWindowLabel = computed(() => {
  const w = status.value?.window
  if (!w) return t('schedule.notScheduled')
  return t('schedule.nextWindow', {
    time: new Date(w.startsAt).toLocaleString(undefined, { timeZone: 'Europe/Kyiv' })
  })
})

/**
 * Enabled, but the server could not derive a window. Today the only cause is a
 * clip with no known duration (handlePutInterrupt now refuses one, so this is
 * a legacy row). NOTHING was sent to any device, so no screen can have missed
 * anything -- say so instead of painting the whole fleet red.
 */
const noWindow = computed(
  () => !!status.value?.config?.enabled && status.value?.window == null
)

const deviceRows = computed(() => status.value?.devices ?? [])

/** Devices that receive a 204 and therefore cannot observe -- surfaced loudly,
 *  not just left to fail silently in the table below. */
const withoutPlaylist = computed(() => deviceRows.value.filter((d) => !d.hasPlaylist))

const columns = computed<TableColumn<InterruptDeviceStatus>[]>(() => [
  { accessorKey: 'name', header: t('devices.colName') },
  { id: 'state', header: t('schedule.statusTitle') }
])

function applyStatus(next: InterruptStatus): void {
  status.value = next
  if (next.config) {
    mediaId.value = next.config.mediaId
    atMinutes.value = next.config.atMinutes
    enabled.value = next.config.enabled
    label.value = next.config.label ?? ''
  }
}

/**
 * Kyiv's current minute-of-day, read straight off the clock. This is the SAFE
 * direction (instant -> wall-clock time in a zone) -- Intl resolves DST for
 * us with no arithmetic on our part. The hazardous direction (a wall-clock
 * time -> the instant it refers to, ambiguous inside a DST fold) is exactly
 * what `server/services/interrupt.ts` owns and this page must never redo.
 */
function kyivMinutesNow(): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(Date.now())
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return hh * 60 + mm
}

/** Today's outcome for one device -- the compliance-critical judgment itself
 *  lives in the pure, unit-tested `deviceInterruptOutcome`. This is just the
 *  impure clock read (kyivMinutesNow) plus the i18n/colour mapping. */
function outcomeFor(d: InterruptDeviceStatus): InterruptOutcome {
  return deviceInterruptOutcome(
    d,
    status.value?.config ?? null,
    kyivMinutesNow(),
    status.value?.window ?? null,
    Date.now()
  )
}

function deviceState(d: InterruptDeviceStatus): string {
  if (noWindow.value) return t('schedule.noWindow')
  switch (outcomeFor(d)) {
    case 'observed':
      return t('schedule.observedAt', { time: new Date(d.lastInterruptAt!).toLocaleTimeString() })
    case 'missed':
      return t('schedule.missed')
    case 'inProgress':
      return t('schedule.inProgress')
    case 'notYet':
      return t('schedule.notYet')
    case 'notScheduled':
      return t('schedule.notScheduled')
    case 'cannotObserve':
      return t('schedule.noPlaylistWarning')
  }
}

function deviceStateColor(d: InterruptDeviceStatus): 'success' | 'error' | 'warning' | 'neutral' {
  if (noWindow.value) return 'warning'
  const outcome = outcomeFor(d)
  if (outcome === 'observed') return 'success'
  if (outcome === 'missed') return 'error'
  // A device that by design cannot observe is a configuration warning, never
  // a failed observance.
  if (outcome === 'cannotObserve') return 'warning'
  return 'neutral'
}

async function refreshStatus(): Promise<void> {
  refreshing.value = true
  try {
    status.value = await api.getInterrupt()
  } catch (err: any) {
    toast.add({
      title: t('schedule.loadFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    refreshing.value = false
  }
}

async function save(): Promise<void> {
  if (mediaId.value === null) return
  saving.value = true
  try {
    applyStatus(
      await api.putInterrupt({
        mediaId: mediaId.value,
        atMinutes: atMinutes.value,
        enabled: enabled.value,
        // Sent rather than leaning on handlePutInterrupt's default, or the
        // stored column is silently non-authoritative: a value written by any
        // other client would be reset by the next dashboard save.
        timezone: status.value?.config?.timezone ?? 'Europe/Kyiv',
        label: label.value.trim() || null
      })
    )
    toast.add({ title: t('schedule.saved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('schedule.saveFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    const [s] = await Promise.all([api.getInterrupt(), mediaStore.refresh()])
    applyStatus(s)
  } catch (err: any) {
    // A silent failure here is the worst possible outcome on this page: it
    // renders identically to a fresh, unconfigured install -- "nothing is
    // scheduled" -- when the truth may be "the fleet's status is unknown."
    toast.add({
      title: t('schedule.loadFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    loading.value = false
  }
  // Armed regardless of the initial load's outcome: a transient failure on
  // mount must not also disarm the page's only path to recovering on its own.
  pollTimer = setInterval(refreshStatus, STATUS_POLL_MS)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('schedule.title')"
      :subtitle="$t('schedule.subtitle')"
      icon="i-lucide-alarm-clock"
    />

    <USkeleton v-if="loading" class="h-72 w-full" />

    <template v-else>
      <UCard class="mb-6">
        <template #header>
          <span class="font-medium">{{ $t('schedule.clip') }}</span>
        </template>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="$t('schedule.enabled')">
            <USwitch v-model="enabled" />
          </UFormField>

          <UFormField :label="$t('schedule.clip')" :hint="$t('schedule.clipHint')">
            <USelectMenu
              v-model="mediaId"
              :items="videos.map((v) => ({ label: v.filename, value: v.id }))"
              value-key="value"
              :placeholder="$t('common.selectPlaceholder')"
              class="w-full"
            />
            <p v-if="videos.length === 0" class="mt-1 text-xs text-(--ui-text-muted)">
              {{ $t('schedule.noClips') }}
            </p>
          </UFormField>

          <UFormField :label="$t('schedule.time')">
            <UInput v-model="timeString" type="time" class="w-full" />
            <p v-if="durationSeconds !== null" class="mt-1 text-xs text-(--ui-text-muted)">
              {{ $t('schedule.duration', { seconds: durationSeconds }) }}
            </p>
          </UFormField>

          <UFormField :label="$t('schedule.timezone')">
            <UInput model-value="Europe/Kyiv" disabled class="w-full" />
          </UFormField>

          <UFormField :label="$t('schedule.label')" class="sm:col-span-2">
            <UInput
              v-model="label"
              :placeholder="$t('schedule.labelPlaceholder')"
              class="w-full sm:max-w-sm"
            />
          </UFormField>
        </div>

        <div class="mt-5 flex flex-wrap items-center gap-3">
          <UButton color="primary" :loading="saving" :disabled="mediaId === null" @click="save">
            {{ $t('schedule.save') }}
          </UButton>
          <span class="text-sm text-(--ui-text-muted)">{{ nextWindowLabel }}</span>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">{{ $t('schedule.statusTitle') }}</span>
            <UButton
              variant="ghost"
              color="neutral"
              size="xs"
              icon="i-lucide-refresh-cw"
              :loading="refreshing"
              :aria-label="$t('schedule.refresh')"
              @click="refreshStatus"
            />
          </div>
        </template>

        <EmptyState
          v-if="!status?.config"
          icon="i-lucide-clock-alert"
          :title="$t('schedule.notScheduled')"
        />

        <template v-else>
          <UAlert
            v-if="noWindow"
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            class="mb-4"
            :title="$t('schedule.noWindowWarning')"
          />

          <UAlert
            v-if="withoutPlaylist.length > 0"
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            class="mb-4"
            :title="$t('schedule.noPlaylistWarning')"
            :description="withoutPlaylist.map((d) => d.name ?? d.id).join(', ')"
          />

          <UTable :data="deviceRows" :columns="columns">
            <template #name-cell="{ row }">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ row.original.name ?? row.original.id }}</span>
                <UIcon
                  v-if="!row.original.hasPlaylist"
                  name="i-lucide-triangle-alert"
                  class="size-3.5 shrink-0 text-amber-500"
                  :title="$t('schedule.noPlaylistWarning')"
                />
              </div>
            </template>
            <template #state-cell="{ row }">
              <UBadge :color="deviceStateColor(row.original)" variant="subtle" size="sm">
                {{ deviceState(row.original) }}
              </UBadge>
            </template>
          </UTable>
        </template>
      </UCard>
    </template>
  </div>
</template>
