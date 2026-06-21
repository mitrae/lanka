<!-- app/pages/devices/[id].vue -->
<script setup lang="ts">
import type { DeviceNowPlaying, ApkRelease, DeviceCommand } from '~/app/types/api'
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'

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
    const updated = await devicesStore.updateDevice(device.value.id, {
      name: editName.value.trim() || null,
      groupId: editGroupId.value
    })
    device.value = updated
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

async function enqueue(cmd: string, extra?: { releaseId?: number }) {
  commandPending.value = true
  try {
    await api.enqueueCommand(id.value, { cmd, ...extra })
    toast.add({ title: `${cmd} command sent`, color: 'success' })
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
    toast.add({ title: 'Failed', description: err.data?.message ?? err.message, color: 'error' })
  } finally {
    commandPending.value = false
  }
}

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
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`
  return `${Math.floor(diff / 86_400_000)} d ago`
}

async function confirmReboot() {
  const ok = await confirm({
    title: 'Restart player?',
    description: 'The device will reload the kiosk WebView.',
    confirmLabel: 'Restart'
  })
  if (ok) enqueue('reboot')
}

async function confirmOta() {
  if (!selectedReleaseId.value) return
  const release = releases.value.find(r => r.id === selectedReleaseId.value)
  const ok = await confirm({
    title: `Push OTA ${release?.version ?? ''}?`,
    description: 'The device will download and silently install the APK.',
    confirmLabel: 'Push OTA'
  })
  if (ok) enqueue('ota', { releaseId: selectedReleaseId.value! })
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
      <section class="soft-card p-6">
        <div class="flex items-start justify-between">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-indigo-500/10 p-3 text-indigo-600 dark:text-indigo-400">
              <UIcon name="i-lucide-tv" class="size-6" />
            </div>
            <div>
              <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
                {{ $t('devices.deviceLabel') }}
              </p>
              <template v-if="!editing">
                <h2 class="mt-1 text-2xl font-semibold text-(--ui-text-highlighted)">
                  {{ device.name ?? $t('devices.unnamed') }}
                </h2>
                <p class="mt-1 font-mono text-xs text-(--ui-text-muted)">
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
                <div class="mt-1 flex w-80 flex-col gap-2">
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
          <div class="flex gap-2">
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

      <NowPlayingCard :status="status" class="mt-8" />

      <section class="soft-card mt-8 p-6">
        <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">{{ $t('devices.playlistSectionTitle') }}</h3>
        <p class="mt-1 text-xs text-(--ui-text-muted)">
          {{ $t('devices.playlistSectionDescription') }}
        </p>
        <!-- Note: currentPlaylistId requires a query to assignments; we pass null for v1 -->
        <AssignmentPicker
          class="mt-4"
          target="device"
          :target-id="device.id"
          :current-playlist-id="null"
          @changed="load"
        />
      </section>

      <!-- Remote Control card -->
      <section class="soft-card mt-8 p-6">
        <h3 class="mb-4 text-sm font-semibold text-(--ui-text-highlighted)">Remote Control</h3>

        <div class="space-y-4">
          <!-- APK version + OTA -->
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm text-(--ui-text-muted)">
              APK on device: <strong>{{ status?.apkVersion ?? '—' }}</strong>
            </span>
            <div class="flex items-center gap-2">
              <USelect
                v-model="selectedReleaseId"
                :items="releases.map(r => ({ label: r.version, value: r.id }))"
                value-key="value"
                placeholder="Select release…"
                class="w-44"
              />
              <UButton
                size="sm"
                :disabled="!selectedReleaseId || commandPending"
                :loading="commandPending"
                @click="confirmOta"
              >Push OTA</UButton>
            </div>
          </div>

          <!-- Other commands -->
          <div class="flex flex-wrap gap-2">
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-refresh-cw"
              :loading="commandPending"
              @click="confirmReboot"
            >Restart player</UButton>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-camera"
              :loading="commandPending"
              @click="enqueue('screenshot')"
            >Screenshot</UButton>
            <UButton
              size="sm"
              variant="outline"
              leading-icon="i-lucide-file-text"
              :loading="commandPending"
              @click="enqueue('log-request')"
            >Pull logs</UButton>
          </div>

          <!-- Recent commands list -->
          <div v-if="commands.length" class="mt-4">
            <p class="mb-2 text-sm font-medium text-(--ui-text-highlighted)">Recent commands</p>
            <div class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border)">
              <div
                v-for="cmd in commands.slice(0, 10)"
                :key="cmd.id"
                class="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <UBadge :color="statusColor(cmd.status)" size="xs" class="shrink-0">{{ cmd.status }}</UBadge>
                <span class="font-mono text-(--ui-text-highlighted)">{{ cmd.cmd }}</span>
                <span class="ml-auto shrink-0 text-xs text-(--ui-text-muted)">{{ relativeTime(cmd.createdAt) }}</span>
                <UButton
                  v-if="cmd.status === 'acked' && cmd.cmd === 'screenshot' && cmd.result"
                  size="xs"
                  variant="ghost"
                  @click="screenshotData = cmd.result; showScreenshotModal = true"
                >view</UButton>
                <UButton
                  v-if="cmd.status === 'acked' && cmd.cmd === 'log-request' && cmd.result"
                  size="xs"
                  variant="ghost"
                  @click="logData = cmd.result; showLogModal = true"
                >view</UButton>
                <UButton
                  v-if="cmd.status === 'failed' && cmd.result"
                  size="xs"
                  variant="ghost"
                  color="error"
                  @click="logData = cmd.result; showLogModal = true"
                >view error</UButton>
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
    title="Device screenshot"
    @update:open="(v) => { if (!v) showScreenshotModal = false }"
  >
    <template #body>
      <img v-if="screenshotData" :src="screenshotData" class="w-full rounded" alt="Device screenshot" />
    </template>
    <template #footer>
      <UButton color="neutral" variant="soft" @click="showScreenshotModal = false">Close</UButton>
    </template>
  </UModal>

  <!-- Log modal -->
  <UModal
    :open="showLogModal"
    title="Device logs"
    @update:open="(v) => { if (!v) showLogModal = false }"
  >
    <template #body>
      <pre class="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{{ logData }}</pre>
    </template>
    <template #footer>
      <UButton color="neutral" variant="soft" @click="showLogModal = false">Close</UButton>
    </template>
  </UModal>
</template>
