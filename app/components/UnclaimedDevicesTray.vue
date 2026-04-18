<!-- app/components/UnclaimedDevicesTray.vue -->
<script setup lang="ts">
import type { DeviceListRow, Group } from '~/app/types/api'
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'

const devicesStore = useDevicesStore()
const groupsStore = useGroupsStore()
const toast = useToast()

const unclaimed = computed<DeviceListRow[]>(() =>
  devicesStore.list.filter((d) => d.groupId === null)
)
const form = ref<Record<string, { name: string; groupId: number | null }>>({})

onMounted(async () => {
  await Promise.all([
    devicesStore.refresh(),
    groupsStore.refresh()
  ])
})

function groupsOf(_row: DeviceListRow) {
  return groupsStore.list.map((g: Group) => ({
    label: g.name,
    value: g.id
  }))
}

async function claim(row: DeviceListRow) {
  const state = form.value[row.id] ?? { name: '', groupId: null }
  if (!state.name || state.groupId === null) {
    toast.add({
      title: 'Enter a name and pick a group',
      color: 'warning'
    })
    return
  }
  try {
    await devicesStore.updateDevice(row.id, {
      name: state.name,
      groupId: state.groupId
    })
    toast.add({ title: `Claimed as "${state.name}"`, color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Claim failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <section
    class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)"
  >
    <header class="flex items-center justify-between border-b border-(--ui-border) px-5 py-3">
      <h2 class="text-sm font-semibold">Unclaimed devices</h2>
      <span class="text-xs text-(--ui-text-muted)">
        {{ unclaimed.length }} pending
      </span>
    </header>
    <div v-if="unclaimed.length === 0" class="p-5">
      <EmptyState
        icon="i-lucide-inbox"
        title="All devices are claimed"
        description="Devices that self-register will appear here."
      />
    </div>
    <ul v-else class="divide-y divide-(--ui-border)">
      <li
        v-for="row in unclaimed"
        :key="row.id"
        class="flex items-center gap-3 px-5 py-3"
      >
        <code class="font-mono text-xs text-(--ui-text-muted) w-60 truncate">
          {{ row.id }}
        </code>
        <UInput
          :model-value="(form[row.id] ||= { name: '', groupId: null }).name"
          placeholder="Name (e.g. TV-Lobby-1)"
          size="sm"
          class="w-48"
          @update:model-value="(val) => (form[row.id] ||= { name: '', groupId: null }).name = String(val)"
        />
        <USelectMenu
          :model-value="(form[row.id] ||= { name: '', groupId: null }).groupId"
          :items="groupsOf(row)"
          value-key="value"
          placeholder="Group"
          size="sm"
          class="w-48"
          @update:model-value="(val) => (form[row.id] ||= { name: '', groupId: null }).groupId = val as number"
        />
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-check"
          @click="claim(row)"
        >
          Claim
        </UButton>
      </li>
    </ul>
  </section>
</template>
