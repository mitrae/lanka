<!-- app/pages/devices/[id].vue -->
<script setup lang="ts">
import { useDevicesStore } from '~/app/stores/devices'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const devicesStore = useDevicesStore()
const groupsStore = useGroupsStore()
const api = useApiClient()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => String(route.params.id))
const device = ref<Awaited<ReturnType<typeof api.getDevice>> | null>(null)

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
      title: 'Load failed',
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
    toast.add({ title: 'Saved', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Save failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function remove() {
  if (!device.value) return
  const ok = await confirm({
    title: `Delete ${device.value.name ?? device.value.id}?`,
    description: 'Removes this device record. The APK on the TV will re-register on next boot.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await devicesStore.deleteDevice(device.value.id)
    router.push('/devices')
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function reload() {
  if (!device.value) return
  try {
    await devicesStore.reloadDevice(device.value.id)
    toast.add({ title: 'Reload signal sent', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Reload failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <div v-if="!device">
      <USkeleton class="h-32 w-full" />
    </div>
    <template v-else>
      <section
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
      >
        <div class="flex items-start justify-between">
          <div class="flex items-start gap-4">
            <div class="rounded-md bg-zinc-500/10 p-3 text-zinc-400">
              <UIcon name="i-lucide-tv" class="size-6" />
            </div>
            <div>
              <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
                Device
              </p>
              <template v-if="!editing">
                <h2 class="mt-1 text-2xl font-semibold">
                  {{ device.name ?? '(unnamed)' }}
                </h2>
                <p class="mt-1 text-xs font-mono text-(--ui-text-muted)">
                  {{ device.id }}
                </p>
                <p class="mt-2 text-sm text-(--ui-text-muted)">
                  Player v{{ device.playerVersion ?? '?' }} ·
                  {{
                    device.lastSeenAt
                      ? `last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      : 'never seen'
                  }}
                </p>
              </template>
              <template v-else>
                <div class="mt-1 flex flex-col gap-2 w-80">
                  <UInput v-model="editName" placeholder="Name" />
                  <USelectMenu
                    v-model="editGroupId"
                    :items="[
                      { label: '— Unclaimed —', value: null },
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
              <UButton variant="soft" icon="i-lucide-refresh-cw" @click="reload">
                Reload player
              </UButton>
              <UButton variant="soft" icon="i-lucide-pencil" @click="editing = true">
                Edit
              </UButton>
              <UButton
                variant="soft"
                color="error"
                icon="i-lucide-trash-2"
                @click="remove"
              >
                Delete
              </UButton>
            </template>
            <template v-else>
              <UButton color="primary" @click="save">Save</UButton>
              <UButton
                variant="ghost"
                @click="
                  editing = false;
                  editName = device!.name ?? '';
                  editGroupId = device!.groupId
                "
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6">
        <h3 class="text-sm font-semibold">Direct playlist assignment</h3>
        <p class="mt-1 text-xs text-(--ui-text-muted)">
          Overrides group- and address-level assignment for this device only.
          Clear to fall back to inherited.
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
    </template>
  </div>
</template>
