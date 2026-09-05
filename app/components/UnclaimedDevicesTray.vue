<!-- app/components/UnclaimedDevicesTray.vue -->
<script setup lang="ts">
import type { DeviceListRow, Group } from '~/app/types/api'
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'

const devicesStore = useDevicesStore()
const groupsStore = useGroupsStore()
const toast = useToast()
const { t } = useI18n()

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
      title: t('components.unclaimedDevicesTray.claimValidation'),
      color: 'warning'
    })
    return
  }
  try {
    await devicesStore.updateDevice(row.id, {
      name: state.name,
      groupId: state.groupId
    })
    toast.add({ title: t('components.unclaimedDevicesTray.claimedAs', { name: state.name }), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('components.unclaimedDevicesTray.claimFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <section class="soft-card overflow-hidden">
    <header class="flex items-center justify-between gap-2 border-b border-(--ui-border) px-4 py-3 sm:px-5">
      <h2 class="text-sm font-semibold">{{ $t('components.unclaimedDevicesTray.title') }}</h2>
      <span class="text-xs text-(--ui-text-muted)">
        {{ $t('components.unclaimedDevicesTray.pending', unclaimed.length, { named: { n: unclaimed.length } }) }}
      </span>
    </header>
    <div v-if="unclaimed.length === 0" class="p-5">
      <EmptyState
        icon="i-lucide-inbox"
        :title="$t('components.unclaimedDevicesTray.allClaimed')"
        :description="$t('components.unclaimedDevicesTray.allClaimedDescription')"
      />
    </div>
    <ul v-else class="divide-y divide-(--ui-border)">
      <li
        v-for="row in unclaimed"
        :key="row.id"
        class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5"
      >
        <code class="w-full truncate font-mono text-xs text-(--ui-text-muted) sm:w-60">
          {{ row.id }}
        </code>
        <UInput
          :model-value="(form[row.id] ||= { name: '', groupId: null }).name"
          :placeholder="$t('components.unclaimedDevicesTray.namePlaceholder')"
          size="sm"
          class="w-full sm:w-48"
          @update:model-value="(val) => (form[row.id] ||= { name: '', groupId: null }).name = String(val)"
        />
        <USelectMenu
          :model-value="(form[row.id] ||= { name: '', groupId: null }).groupId"
          :items="groupsOf(row)"
          value-key="value"
          :placeholder="$t('components.unclaimedDevicesTray.groupPlaceholder')"
          size="sm"
          class="w-full sm:w-48"
          @update:model-value="(val) => (form[row.id] ||= { name: '', groupId: null }).groupId = val as number"
        />
        <UButton
          color="primary"
          size="sm"
          class="w-full justify-center sm:w-auto"
          icon="i-lucide-check"
          @click="claim(row)"
        >
          {{ $t('components.unclaimedDevicesTray.claim') }}
        </UButton>
      </li>
    </ul>
  </section>
</template>
