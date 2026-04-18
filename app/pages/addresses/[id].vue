<!-- app/pages/addresses/[id].vue -->
<script setup lang="ts">
import { useAddressesStore } from '~/app/stores/addresses'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const addressesStore = useAddressesStore()
const groupsStore = useGroupsStore()
const api = useApiClient()
const toast = useToast()

const id = computed(() => Number(route.params.id))

const address = ref<Awaited<ReturnType<typeof api.getAddress>> | null>(null)
const editing = ref(false)
const editName = ref('')

const newGroupName = ref('')

onMounted(async () => {
  try {
    address.value = await api.getAddress(id.value)
    editName.value = address.value.name
    await groupsStore.refresh({ addressId: id.value })
  } catch (err: any) {
    toast.add({
      title: 'Load failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
})

async function save() {
  if (!address.value || !editName.value.trim()) return
  try {
    const updated = await addressesStore.update(address.value.id, {
      name: editName.value.trim()
    })
    address.value = updated
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

async function createGroup() {
  if (!address.value || !newGroupName.value.trim()) return
  try {
    await groupsStore.create({
      addressId: address.value.id,
      name: newGroupName.value.trim()
    })
    toast.add({ title: 'Group created', color: 'success' })
    newGroupName.value = ''
  } catch (err: any) {
    toast.add({
      title: 'Create failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

const confirm = useConfirm()
async function remove() {
  if (!address.value) return
  const ok = await confirm({
    title: `Delete ${address.value.name}?`,
    description:
      'Removes this address and cascades to all groups. Devices in those groups will become unclaimed.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await addressesStore.delete(address.value.id)
    router.push('/addresses')
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
    <div v-if="!address">
      <USkeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <section
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
      >
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
              Address
            </p>
            <template v-if="!editing">
              <h2 class="mt-1 text-2xl font-semibold">{{ address.name }}</h2>
              <p class="mt-1 text-xs font-mono text-(--ui-text-muted)">
                #{{ address.id }}
              </p>
            </template>
            <template v-else>
              <UInput
                v-model="editName"
                autofocus
                class="mt-1"
                @keyup.enter="save"
              />
            </template>
          </div>
          <div class="flex gap-2">
            <template v-if="!editing">
              <UButton
                variant="soft"
                icon="i-lucide-pencil"
                @click="editing = true"
              >
                Rename
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
                @click="editing = false; editName = address!.name"
              >
                Cancel
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Groups in this address</h3>
        </div>
        <div class="mt-4 flex items-center gap-2">
          <UInput
            v-model="newGroupName"
            placeholder="New group name (e.g. Lobby)"
            class="flex-1 max-w-md"
            @keyup.enter="createGroup"
          />
          <UButton color="primary" icon="i-lucide-plus" @click="createGroup">
            Add group
          </UButton>
        </div>

        <EmptyState
          v-if="groupsStore.list.length === 0 && !groupsStore.loading"
          class="mt-4"
          icon="i-lucide-folder"
          title="No groups yet"
          description="Groups subdivide an address. A clinic might have 'Lobby' and 'Cafeteria' groups."
        />
        <ul v-else class="mt-4 space-y-2">
          <li
            v-for="g in groupsStore.list"
            :key="g.id"
            class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
          >
            <NuxtLink :to="`/groups/${g.id}`" class="flex-1 flex items-center gap-3">
              <UIcon name="i-lucide-folder" class="size-5 text-(--ui-text-muted)" />
              <span class="font-medium">{{ g.name }}</span>
            </NuxtLink>
            <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
