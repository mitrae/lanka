<!-- app/pages/groups/[id].vue -->
<script setup lang="ts">
import { useGroupsStore } from '~/app/stores/groups'
import { useAddressesStore } from '~/app/stores/addresses'
import { useDevicesStore } from '~/app/stores/devices'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const groupsStore = useGroupsStore()
const addressesStore = useAddressesStore()
const devicesStore = useDevicesStore()
const api = useApiClient()
const toast = useToast()
const confirm = useConfirm()

const id = computed(() => Number(route.params.id))
const group = ref<Awaited<ReturnType<typeof api.getGroup>> | null>(null)
const editing = ref(false)
const editName = ref('')
const editAddressId = ref<number | null>(null)

onMounted(async () => {
  try {
    const [g] = await Promise.all([
      api.getGroup(id.value),
      addressesStore.refresh(),
      devicesStore.refresh({ groupId: id.value })
    ])
    group.value = g
    editName.value = g.name
    editAddressId.value = g.addressId
  } catch (err: any) {
    toast.add({
      title: 'Load failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
})

const addressItems = computed(() =>
  addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
)

async function save() {
  if (!group.value) return
  try {
    const updated = await groupsStore.update(group.value.id, {
      name: editName.value.trim(),
      addressId: editAddressId.value ?? undefined
    })
    group.value = updated
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
  if (!group.value) return
  const ok = await confirm({
    title: `Delete ${group.value.name}?`,
    description:
      'Devices in this group will become unclaimed (their group_id will be set to null).',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await groupsStore.delete(group.value.id)
    router.push('/groups')
  } catch (err: any) {
    toast.add({
      title: 'Delete failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div>
    <template #header>
      <NuxtLink to="/groups" class="hover:text-(--ui-text)">Groups</NuxtLink>
      <span> / </span>
      <span class="text-(--ui-text)">{{ group?.name ?? '…' }}</span>
    </template>

    <div v-if="!group">
      <USkeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <section
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
      >
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
              Group
            </p>
            <template v-if="!editing">
              <h2 class="mt-1 text-2xl font-semibold">{{ group.name }}</h2>
              <p class="mt-1 text-sm text-(--ui-text-muted)">
                in {{ addressesStore.list.find((a) => a.id === group!.addressId)?.name ?? '?' }}
              </p>
            </template>
            <template v-else>
              <div class="mt-1 flex flex-col gap-2 w-80">
                <UInput v-model="editName" />
                <USelectMenu
                  v-model="editAddressId"
                  :items="addressItems"
                  value-key="value"
                />
              </div>
            </template>
          </div>
          <div class="flex gap-2">
            <template v-if="!editing">
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
                  editing = false
                  editName = group!.name
                  editAddressId = group!.addressId
                "
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <h3 class="text-sm font-semibold">Devices in this group</h3>
        <EmptyState
          v-if="devicesStore.list.length === 0"
          class="mt-4"
          icon="i-lucide-tv"
          title="No devices yet"
          description="Devices self-register and appear as unclaimed. Claim them from Overview or the Devices list."
        />
        <ul v-else class="mt-4 space-y-2">
          <li
            v-for="d in devicesStore.list"
            :key="d.id"
            class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
          >
            <NuxtLink :to="`/devices/${d.id}`" class="flex-1 flex items-center gap-3">
              <StatusDot :status="d.status" />
              <span class="font-medium">{{ d.name ?? 'Unnamed' }}</span>
              <code class="text-xs font-mono text-(--ui-text-muted) truncate max-w-xs">
                {{ d.id }}
              </code>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
