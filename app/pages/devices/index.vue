<!-- app/pages/devices/index.vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useAddressesStore } from '~/app/stores/addresses'
import { useGroupsStore } from '~/app/stores/groups'
import { useDashboardStream } from '~/app/composables/useDashboardStream'

definePageMeta({ layout: 'default' })

const devicesStore = useDevicesStore()
const addressesStore = useAddressesStore()
const groupsStore = useGroupsStore()

const addressFilter = ref<number | null>(null)
const groupFilter = ref<number | null>(null)
const statusFilter = ref<'all' | 'online' | 'idle' | 'offline' | 'unclaimed'>(
  'all'
)

async function refresh() {
  const query: { addressId?: number; groupId?: number; unclaimed?: boolean } = {}
  if (addressFilter.value !== null) query.addressId = addressFilter.value
  if (groupFilter.value !== null) query.groupId = groupFilter.value
  if (statusFilter.value === 'unclaimed') query.unclaimed = true
  await devicesStore.refresh(query)
}

onMounted(async () => {
  await Promise.all([
    addressesStore.refresh(),
    groupsStore.refresh(),
    refresh()
  ])
  if (import.meta.client) {
    const stream = useDashboardStream()
    stream.onDeviceEvent((p) => devicesStore.applyDeviceEvent(p))
  }
})

watch([addressFilter, groupFilter, statusFilter], refresh)

const visible = computed(() => {
  if (
    statusFilter.value === 'all' ||
    statusFilter.value === 'unclaimed'
  ) {
    return devicesStore.list
  }
  return devicesStore.list.filter((d) => d.status === statusFilter.value)
})

function groupName(gid: number | null) {
  if (gid === null) return 'Unclaimed'
  return groupsStore.list.find((g) => g.id === gid)?.name ?? `#${gid}`
}

function addressForGroup(gid: number | null) {
  if (gid === null) return ''
  const g = groupsStore.list.find((x) => x.id === gid)
  if (!g) return ''
  return addressesStore.list.find((a) => a.id === g.addressId)?.name ?? ''
}

function fmtAge(iso: string | null) {
  if (!iso) return 'never'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
</script>

<template>
  <div>
    <template #header>Devices</template>
    <div class="flex items-center gap-3">
      <USelectMenu
        v-model="addressFilter"
        :items="[
          { label: 'All addresses', value: null },
          ...addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
        ]"
        value-key="value"
        placeholder="Address"
        class="w-48"
      />
      <USelectMenu
        v-model="groupFilter"
        :items="[
          { label: 'All groups', value: null },
          ...groupsStore.list.map((g) => ({ label: g.name, value: g.id }))
        ]"
        value-key="value"
        placeholder="Group"
        class="w-48"
      />
      <USelectMenu
        v-model="statusFilter"
        :items="[
          { label: 'Any status', value: 'all' },
          { label: 'Online', value: 'online' },
          { label: 'Idle', value: 'idle' },
          { label: 'Offline', value: 'offline' },
          { label: 'Unclaimed', value: 'unclaimed' }
        ]"
        value-key="value"
        class="w-40"
      />
    </div>

    <div class="mt-6 overflow-hidden rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)">
      <table class="w-full text-sm">
        <thead class="bg-(--ui-bg-accented) text-xs uppercase tracking-wide text-(--ui-text-muted)">
          <tr>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Name</th>
            <th class="px-4 py-3 text-left">Location</th>
            <th class="px-4 py-3 text-left">Last seen</th>
            <th class="px-4 py-3 text-left">Device ID</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--ui-border)">
          <tr
            v-for="d in visible"
            :key="d.id"
            class="hover:bg-(--ui-bg-accented) transition-colors cursor-pointer"
            @click="$router.push(`/devices/${d.id}`)"
          >
            <td class="px-4 py-3">
              <StatusDot :status="d.status" label />
            </td>
            <td class="px-4 py-3 font-medium">
              {{ d.name ?? '(unnamed)' }}
            </td>
            <td class="px-4 py-3 text-(--ui-text-muted)">
              {{ groupName(d.groupId) }}
              <span v-if="addressForGroup(d.groupId)">
                · {{ addressForGroup(d.groupId) }}
              </span>
            </td>
            <td class="px-4 py-3 text-(--ui-text-muted)">{{ fmtAge(d.lastSeenAt) }}</td>
            <td class="px-4 py-3">
              <code class="text-xs font-mono text-(--ui-text-muted) truncate max-w-xs">
                {{ d.id }}
              </code>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="visible.length === 0" class="p-8">
        <EmptyState
          icon="i-lucide-tv"
          title="No devices match"
          description="Adjust filters, or wait for devices to self-register."
        />
      </div>
    </div>
  </div>
</template>
