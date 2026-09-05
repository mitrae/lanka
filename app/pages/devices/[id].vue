<!-- app/pages/devices/[id].vue -->
<script setup lang="ts">
import type { DeviceNowPlaying, ApkRelease, DeviceCommand } from '~/app/types/api'
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'
import { surfaceSwitchView, type SurfaceName } from '~/app/utils/surfaceSwitch'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const devicesStore = useDevicesStore()
const groupsStore = useGroupsStore()
const api = useApiClient()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => String(route.params.id))
const device = ref<Awaited<ReturnType<typeof api.getDevice>> | null>(null)

const status = ref<DeviceNowPlaying | null>(null)
let statusTimer: ReturnType<typeof setInterval> | null = null
async function refreshStatus() {
  try { status.value = await api.getDeviceStatus(id.value) } catch { /* keep last */ }
}
onMounted(() => { refreshStatus(); statusTimer = setInterval(refreshStatus, 5000) })
onBeforeUnmount(() => { if (statusTimer) clearInterval(statusTimer) })

const effectivePlaylistLabel = computed(() => {
  const d = device.value
  if (!d) return null
  if (!d.effectivePlaylistId) return t('devices.effectivePlaylistNone')
  const name = d.effectivePlaylistName ?? `#${d.effectivePlaylistId}`
  switch (d.effectiveLevel) {
    case 'device':
      return t('devices.effectivePlaylistDevice', { name })
    case 'group':
      return t('devices.effectivePlaylistGroup', { name })
    case 'address':
      return t('devices.effectivePlaylistAddress', { name })
    default:
      return null
  }
})

const editing = ref(false)
const editName = ref('')
const editGroupId = ref<number | null>(null)

async function load() {
  try {
    device.value = await api.getDevice(id.value)
    editName.value = device.value.name ?? ''
    editGroupId.value = device.value.groupId
    await groupsStore.refresh()
  } catch (err: any) {
    toast.add({
      title: t('devices.loadFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

onMounted(load)

async function save() {
  if (!device.value) return
  try {
    await devicesStore.updateDevice(device.value.id, {
      name: editName.value.trim() || null,
      groupId: editGroupId.value
    })
    // Reload rather than reuse the PATCH row: moving the device to another
    // group changes which playlist it inherits.
    await load()
    editing.value = false
    toast.add({ title: t('devices.saved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('devices.saveFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function remove() {
  if (!device.value) return
  const name = device.value.name ?? device.value.id
  const ok = await confirm({
    title: t('devices.deleteConfirmTitle', { name }),
    description: t('devices.deleteConfirmDescription'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await devicesStore.deleteDevice(device.value.id)
    router.push('/devices')
  } catch (err: any) {
    toast.add({
      title: t('devices.deleteFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function reload() {
  if (!device.value) return
  try {
    await devicesStore.reloadDevice(device.value.id)
    toast.add({ title: t('devices.reloadSignalSent'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('devices.reloadFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

// ── Remote Control ──────────────────────────────────────────────────────────
const commands = ref<DeviceCommand[]>([])
const releases = ref<ApkRelease[]>([])
const selectedReleaseId = ref<number | null>(null)
const commandPending = ref(false)
const screenshotData = ref<string | null>(null)
const logData = ref<string | null>(null)
const showLogModal = ref(false)
const showScreenshotModal = ref(false)

async function loadCommands() {
  try { commands.value = await api.listDeviceCommands(id.value) } catch {}
}
async function loadReleases() {
  try { releases.value = await api.listApkReleases() } catch {}
}

onMounted(() => { loadCommands(); loadReleases() })

// Auto-refresh commands every 10s
let commandsTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { commandsTimer = setInterval(loadCommands, 10_000) })
onBeforeUnmount(() => { if (commandsTimer) clearInterval(commandsTimer) })

async function enqueue(cmd: string, extra?: { releaseId?: number; surface?: SurfaceName }) {
  commandPending.value = true
  try {
    await api.enqueueCommand(id.value, { cmd, ...extra })
    toast.add({ title: t('devices.commandSent', { cmd: commandLabel(cmd) }), color: 'success' })
    await loadCommands()
    if (cmd === 'screenshot') {
      // Poll for ack up to 30s (15 × 2s)
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await loadCommands()
        const latest = commands.value.find(c => c.cmd === 'screenshot' && c.status === 'acked')
        if (latest?.result) {
          screenshotData.value = latest.result
          showScreenshotModal.value = true
          break
        }
      }
    }
    if (cmd === 'log-request') {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await loadCommands()
        const latest = commands.value.find(c => c.cmd === 'log-request' && c.status === 'acked')
        if (latest?.result) { logData.value = latest.result; showLogModal.value = true; break }
      }
    }
  } catch (err: any) {
    toast.add({
      title: t('devices.commandFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    commandPending.value = false
  }
}

// Wire enums → operator-facing labels. The raw enum stays in the row's
// `title` attribute, so a log or a doc reference is still greppable from the UI.
const COMMAND_LABEL_KEYS: Record<string, string> = {
  ota: 'devices.cmdOta',
  reboot: 'devices.cmdReboot',
  screenshot: 'devices.cmdScreenshot',
  'log-request': 'devices.cmdLogRequest',
  'kiosk-lock': 'devices.cmdKioskLock',
  'kiosk-unlock': 'devices.cmdKioskUnlock',
  'set-surface': 'devices.cmdSetSurface'
}
const COMMAND_STATUS_KEYS: Record<string, string> = {
  pending: 'devices.cmdStatusPending',
  sent: 'devices.cmdStatusSent',
  acked: 'devices.cmdStatusAcked',
  failed: 'devices.cmdStatusFailed'
}
const commandLabel = (cmd: string) => (COMMAND_LABEL_KEYS[cmd] ? t(COMMAND_LABEL_KEYS[cmd]!) : cmd)
const commandStatusLabel = (s: string) => (COMMAND_STATUS_KEYS[s] ? t(COMMAND_STATUS_KEYS[s]!) : s)

function statusColor(s: string): 'warning' | 'info' | 'success' | 'error' | 'neutral' {
  const map: Record<string, 'warning' | 'info' | 'success' | 'error'> = {
    pending: 'warning',
    sent: 'info',
    acked: 'success',
    failed: 'error'
  }
  return map[s] ?? 'neutral'
}

function relativeTime(ts: string | number): string {
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return t('devices.agoSeconds', { n: s })
  if (s < 3600) return t('devices.agoMinutes', { n: Math.floor(s / 60) })
  if (s < 86400) return t('devices.agoHours', { n: Math.floor(s / 3600) })
  return t('devices.agoDays', { n: Math.floor(s / 86400) })
}

// Named for its intent, not its fallback: the command asks the box for a real
// OS reboot (device-owner only) and degrades to a player reload elsewhere —
// which is exactly what the header's "Reload player" button does on its own.
async function confirmReboot() {
  const ok = await confirm({
    title: t('devices.rebootConfirmTitle'),
    description: t('devices.rebootConfirmDescription'),
    confirmLabel: t('devices.rebootConfirmLabel')
  })
  if (ok) enqueue('reboot')
}

async function confirmOta() {
  if (!selectedReleaseId.value) return
  const release = releases.value.find(r => r.id === selectedReleaseId.value)
  const ok = await confirm({
    title: t('devices.otaConfirmTitle', { version: release?.version ?? '' }),
    description: t('devices.otaConfirmDescription'),
    confirmLabel: t('devices.otaConfirmLabel')
  })
  if (ok) enqueue('ota', { releaseId: selectedReleaseId.value! })
}

// ── Kiosk visibility ────────────────────────────────────────────────────────
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

// ── Player surface (set-surface) ────────────────────────────────────────────
// Unknown/loading must not read as "WebView": status arrives a beat after the page.
const surfaceLabel = (s: SurfaceName | null | undefined) =>
  s === 'native' ? 'Native' : s === 'webview' ? 'WebView' : '—'
const otherSurface = computed<SurfaceName>(() => (status.value?.surface === 'native' ? 'webview' : 'native'))
const SURFACE_PHASE_KEYS: Record<string, string> = {
  queued: 'devices.phaseQueued',
  sent: 'devices.phaseSent',
  applying: 'devices.phaseApplying',
  failed: 'devices.phaseFailed'
}
const phaseLabel = (p: string) => (SURFACE_PHASE_KEYS[p] ? t(SURFACE_PHASE_KEYS[p]!) : p)
// Re-evaluated on every 10 s command poll / 5 s status poll (both replace the refs).
const surfaceSwitch = computed(() =>
  surfaceSwitchView(commands.value, (status.value?.surface as SurfaceName | undefined) ?? null, Date.now())
)
const surfaceSwitchInFlight = computed(() =>
  surfaceSwitch.value.phase === 'queued' || surfaceSwitch.value.phase === 'sent'
)

async function confirmSurfaceSwitch() {
  const target = otherSurface.value
  const ok = await confirm({
    title: t('devices.surfaceConfirmTitle', { surface: surfaceLabel(target) }),
    description: t('devices.surfaceConfirmDescription'),
    confirmLabel: t('devices.surfaceConfirmLabel')
  })
  if (ok) enqueue('set-surface', { surface: target })
}
</script>

<template>
  <div class="reveal">
    <NuxtLink
      to="/devices"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-(--ui-text-muted) transition-colors hover:text-(--ui-text)"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" /> {{ $t('devices.backToDevices') }}
    </NuxtLink>

    <div v-if="!device">
      <USkeleton class="h-32 w-full" />
    </div>
    <template v-else>
      <section class="soft-card p-4 sm:p-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex min-w-0 items-start gap-3 sm:gap-4">
            <div class="shrink-0 rounded-xl bg-indigo-500/10 p-2.5 text-indigo-600 sm:p-3 dark:text-indigo-400">
              <UIcon name="i-lucide-tv" class="size-6" />
            </div>
            <div class="min-w-0">
              <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
                {{ $t('devices.deviceLabel') }}
              </p>
              <template v-if="!editing">
                <h2 class="mt-1 text-xl font-semibold text-(--ui-text-highlighted) sm:text-2xl">
                  {{ device.name ?? $t('devices.unnamed') }}
                </h2>
                <p class="mt-1 break-all font-mono text-xs text-(--ui-text-muted)">
                  {{ device.id }}
                </p>
                <p class="mt-2 text-sm text-(--ui-text-muted)">
                  {{ $t('devices.playerVersion', { version: device.playerVersion ?? '?' }) }} ·
                  {{
                    device.lastSeenAt
                      ? $t('devices.lastSeenAt', { time: new Date(device.lastSeenAt).toLocaleString() })
                      : $t('devices.neverSeen')
                  }}
                </p>
              </template>
              <template v-else>
                <div class="mt-1 flex w-full flex-col gap-2 sm:w-80">
                  <UInput v-model="editName" :placeholder="$t('devices.namePlaceholder')" />
                  <USelectMenu
                    v-model="editGroupId"
                    :items="[
                      { label: $t('devices.unclaimedOption'), value: null },
                      ...groupsStore.list.map((g) => ({ label: g.name, value: g.id }))
                    ]"
                    value-key="value"
                  />
                </div>
              </template>
            </div>
          </div>
          <div class="flex flex-wrap gap-2 sm:shrink-0">
            <template v-if="!editing">
              <UButton variant="soft" color="neutral" icon="i-lucide-refresh-cw" @click="reload">
                {{ $t('devices.reloadPlayer') }}
              </UButton>
              <UButton variant="soft" color="neutral" icon="i-lucide-pencil" @click="editing = true">
                {{ $t('common.edit') }}
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="remove"
              >
                {{ $t('common.delete') }}
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="save">{{ $t('common.save') }}</UButton>
              <UButton
                variant="ghost"
                color="neutral"
                @click="
                  editing = false;
                  editName = device!.name ?? '';
                  editGroupId = device!.groupId
                "
              >
                {{ $t('common.cancel') }}
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <NowPlayingCard :status="status" class="mt-6 sm:mt-8" />

      <section class="soft-card mt-6 p-4 sm:mt-8 sm:p-6">
        <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">{{ $t('devices.playlistSectionTitle') }}</h3>
        <p class="mt-1 text-xs text-(--ui-text-muted)">
          {{ $t('devices.playlistSectionDescription') }}
        </p>
        <AssignmentPicker
          class="mt-4"
          target="device"
          :target-id="device.id"
          :current-playlist-id="device.directPlaylistId"
          @changed="load"
        />
        <p
          v-if="effectivePlaylistLabel"
          class="mt-3 flex items-center gap-1.5 text-xs text-(--ui-text-muted)"
        >
          <UIcon
            :name="device.effectivePlaylistId ? 'i-lucide-list-video' : 'i-lucide-triangle-alert'"
            class="size-4 shrink-0"
          />
          {{ effectivePlaylistLabel }}
        </p>
      </section>

      <!-- Remote Control card -->
      <section class="soft-card mt-6 p-4 sm:mt-8 sm:p-6">
        <h3 class="mb-4 text-sm font-semibold text-(--ui-text-highlighted)">
          {{ $t('devices.remoteControlTitle') }}
        </h3>

        <div class="space-y-4">
          <!-- Player surface (runtime-selectable; one APK carries both) -->
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm text-(--ui-text-muted)">{{ $t('devices.playerSurfaceLabel') }}</span>
            <UBadge :color="status?.surface === 'native' ? 'primary' : 'neutral'" variant="subtle" size="sm">
              {{ surfaceLabel(status?.surface) }}
            </UBadge>
            <VisibilityBadge
              :visibility="status?.visibility ?? 'unknown'"
              :foreground-package="status?.foregroundPackage"
              :online="status?.online ?? false"
            />
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-arrow-left-right"
              :disabled="commandPending || surfaceSwitchInFlight"
              :loading="commandPending"
              @click="confirmSurfaceSwitch"
            >{{ $t('devices.switchToSurface', { surface: surfaceLabel(otherSurface) }) }}</UButton>
            <span v-if="surfaceSwitchInFlight" class="text-xs text-(--ui-text-muted)">
              {{ $t('devices.switchingToSurface', {
                surface: surfaceLabel(surfaceSwitch.requested),
                phase: phaseLabel(surfaceSwitch.phase)
              }) }}
            </span>
            <span v-else-if="surfaceSwitch.phase === 'applying'" class="text-xs text-(--ui-text-muted)">
              {{ $t('devices.applyingSurface', { surface: surfaceLabel(surfaceSwitch.requested) }) }}
            </span>
            <span v-else-if="surfaceSwitch.phase === 'failed'" class="text-xs text-(--ui-text-error)">
              {{ $t('devices.switchToSurfaceFailed', {
                surface: surfaceLabel(surfaceSwitch.requested),
                reason: surfaceSwitch.reason ?? $t('devices.unknownReason')
              }) }}
            </span>
          </div>

          <!-- Kiosk visibility. Two different questions, deliberately not
               conflated: hiddenFor is how long THIS occlusion has lasted,
               hiddenTime is the total since the app process started. -->
          <p
            v-if="status && status.online && status.visibility !== 'foreground'
              && status.visibility !== 'unknown' && status.visibilitySince"
            class="text-xs text-(--ui-text-warning)"
          >
            {{ $t('devices.hiddenFor', { duration: fmtDuration(Date.now() - status.visibilitySince) }) }}
          </p>
          <p v-if="status" class="text-xs text-(--ui-text-dimmed)">
            {{ $t('devices.kioskIntegrity') }}:
            {{ $t('devices.snapBacks') }} {{ status.snapBacks }} ·
            {{ $t('devices.focusLosses') }} {{ status.focusLosses }} ·
            {{ $t('devices.hiddenTime') }} {{ fmtDuration(status.hiddenMs) }}
            <span class="opacity-70">({{ $t('devices.sinceAppStart') }})</span>
          </p>

          <!-- APK version + OTA -->
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm text-(--ui-text-muted)">
              {{ $t('devices.apkOnDevice') }} <strong>{{ status?.apkVersion ?? '—' }}</strong>
            </span>
            <div class="flex w-full items-center gap-2 sm:w-auto">
              <USelect
                v-model="selectedReleaseId"
                :items="releases.map(r => ({ label: r.version, value: r.id }))"
                value-key="value"
                :placeholder="$t('devices.selectReleasePlaceholder')"
                class="w-full sm:w-44"
              />
              <UButton
                size="sm"
                :disabled="!selectedReleaseId || commandPending"
                :loading="commandPending"
                @click="confirmOta"
              >{{ $t('devices.pushOta') }}</UButton>
            </div>
          </div>

          <!-- Other commands -->
          <div class="flex flex-wrap gap-2">
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-power"
              :loading="commandPending"
              @click="confirmReboot"
            >{{ $t('devices.rebootDevice') }}</UButton>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-camera"
              :loading="commandPending"
              @click="enqueue('screenshot')"
            >{{ $t('devices.screenshot') }}</UButton>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-file-text"
              :loading="commandPending"
              @click="enqueue('log-request')"
            >{{ $t('devices.pullLogs') }}</UButton>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-lock"
              :loading="commandPending"
              @click="enqueue('kiosk-lock')"
            >{{ $t('devices.kioskLock') }}</UButton>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-lock-open"
              :loading="commandPending"
              @click="enqueue('kiosk-unlock')"
            >{{ $t('devices.kioskUnlock') }}</UButton>
          </div>

          <!-- Recent commands list -->
          <div v-if="commands.length" class="mt-4">
            <p class="mb-2 text-sm font-medium text-(--ui-text-highlighted)">
              {{ $t('devices.recentCommands') }}
            </p>
            <div class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border)">
              <div
                v-for="cmd in commands.slice(0, 10)"
                :key="cmd.id"
                class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <UBadge :color="statusColor(cmd.status)" size="xs" class="shrink-0">
                  {{ commandStatusLabel(cmd.status) }}
                </UBadge>
                <span class="min-w-0 truncate text-(--ui-text-highlighted)" :title="cmd.cmd">{{ commandLabel(cmd.cmd) }}</span>
                <span class="ml-auto shrink-0 text-xs text-(--ui-text-muted)">{{ relativeTime(cmd.createdAt) }}</span>
                <UButton
                  v-if="cmd.status === 'acked' && cmd.cmd === 'screenshot' && cmd.result"
                  size="xs"
                  variant="ghost"
                  @click="screenshotData = cmd.result; showScreenshotModal = true"
                >{{ $t('devices.viewResult') }}</UButton>
                <UButton
                  v-if="cmd.status === 'acked' && cmd.cmd === 'log-request' && cmd.result"
                  size="xs"
                  variant="ghost"
                  @click="logData = cmd.result; showLogModal = true"
                >{{ $t('devices.viewResult') }}</UButton>
                <UButton
                  v-if="cmd.status === 'failed' && cmd.result"
                  size="xs"
                  variant="ghost"
                  color="error"
                  @click="logData = cmd.result; showLogModal = true"
                >{{ $t('devices.viewError') }}</UButton>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>

  <!-- Screenshot modal -->
  <UModal
    :open="showScreenshotModal"
    :title="$t('devices.screenshotModalTitle')"
    @update:open="(v) => { if (!v) showScreenshotModal = false }"
  >
    <template #body>
      <img
        v-if="screenshotData"
        :src="screenshotData"
        class="w-full rounded"
        :alt="$t('devices.screenshotModalTitle')"
      />
    </template>
    <template #footer>
      <UButton color="neutral" variant="soft" @click="showScreenshotModal = false">
        {{ $t('common.close') }}
      </UButton>
    </template>
  </UModal>

  <!-- Log modal -->
  <UModal
    :open="showLogModal"
    :title="$t('devices.logsModalTitle')"
    @update:open="(v) => { if (!v) showLogModal = false }"
  >
    <template #body>
      <pre class="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{{ logData }}</pre>
    </template>
    <template #footer>
      <UButton color="neutral" variant="soft" @click="showLogModal = false">
        {{ $t('common.close') }}
      </UButton>
    </template>
  </UModal>
</template>
