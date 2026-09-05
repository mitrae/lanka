<!-- app/pages/addresses/[id].vue -->
<script setup lang="ts">
import { useAddressesStore } from '~/app/stores/addresses'
import { useGroupsStore } from '~/app/stores/groups'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
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

async function load() {
  try {
    address.value = await api.getAddress(id.value)
    editName.value = address.value.name
    await groupsStore.refresh({ addressId: id.value })
  } catch (err: any) {
    toast.add({
      title: t('addresses.loadFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

onMounted(load)

const effectivePlaylistLabel = computed(() => {
  const a = address.value
  if (!a) return null
  if (!a.effectivePlaylistId) return t('addresses.effectivePlaylistNone')
  const name = a.effectivePlaylistName ?? `#${a.effectivePlaylistId}`
  return t('addresses.effectivePlaylistAddress', { name })
})

async function save() {
  const current = address.value
  if (!current || !editName.value.trim()) return
  try {
    const updated = await addressesStore.update(current.id, {
      name: editName.value.trim()
    })
    // Merge: the PATCH row carries no assignment fields, and a rename can't
    // change them.
    address.value = { ...current, ...updated }
    editing.value = false
    toast.add({ title: t('addresses.saved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('addresses.saveFailed'),
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
    toast.add({ title: t('addresses.groupCreated'), color: 'success' })
    newGroupName.value = ''
  } catch (err: any) {
    toast.add({
      title: t('addresses.createFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

const confirm = useConfirm()
async function remove() {
  if (!address.value) return
  const ok = await confirm({
    title: t('addresses.deleteConfirmTitle', { name: address.value.name }),
    description: t('addresses.deleteConfirmDescription'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await addressesStore.delete(address.value.id)
    router.push('/addresses')
  } catch (err: any) {
    toast.add({
      title: t('addresses.deleteFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <NuxtLink
      to="/addresses"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-(--ui-text-muted) transition-colors hover:text-(--ui-text)"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" /> {{ $t('nav.addresses') }}
    </NuxtLink>

    <div v-if="!address">
      <USkeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <section class="soft-card p-4 sm:p-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex min-w-0 items-start gap-3 sm:gap-4">
            <div class="shrink-0 rounded-xl bg-indigo-500/10 p-2.5 text-indigo-600 sm:p-3 dark:text-indigo-400">
              <UIcon name="i-lucide-building-2" class="size-6" />
            </div>
            <div>
              <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
                {{ $t('addresses.addressLabel') }}
              </p>
              <template v-if="!editing">
                <h2 class="mt-1 truncate text-xl font-semibold text-(--ui-text-highlighted) sm:text-2xl">{{ address.name }}</h2>
                <p class="mt-1 break-all font-mono text-xs text-(--ui-text-muted)">
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
          </div>
          <div class="flex flex-wrap gap-2 sm:shrink-0">
            <template v-if="!editing">
              <UButton
                variant="soft"
                color="neutral"
                icon="i-lucide-pencil"
                @click="editing = true"
              >
                {{ $t('addresses.rename') }}
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
                @click="editing = false; editName = address!.name"
              >
                {{ $t('common.cancel') }}
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="soft-card mt-6 p-4 sm:mt-8 sm:p-6">
        <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">{{ $t('addresses.playlistSectionTitle') }}</h3>
        <p class="mt-1 text-xs text-(--ui-text-muted)">
          {{ $t('addresses.playlistSectionDescription') }}
        </p>
        <AssignmentPicker
          class="mt-4"
          target="address"
          :target-id="address.id"
          :current-playlist-id="address.directPlaylistId"
          @changed="load"
        />
        <p
          v-if="effectivePlaylistLabel"
          class="mt-3 flex items-center gap-1.5 text-xs text-(--ui-text-muted)"
        >
          <UIcon
            :name="address.effectivePlaylistId ? 'i-lucide-list-video' : 'i-lucide-triangle-alert'"
            class="size-4 shrink-0"
          />
          {{ effectivePlaylistLabel }}
        </p>
      </section>

      <section class="mt-6 sm:mt-8">
        <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">{{ $t('addresses.groupsInAddress') }}</h3>
        <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <UInput
            v-model="newGroupName"
            :placeholder="$t('addresses.newGroupPlaceholder')"
            class="w-full sm:max-w-md sm:flex-1"
            @keyup.enter="createGroup"
          />
          <UButton color="primary" icon="i-lucide-plus" @click="createGroup">
            {{ $t('addresses.addGroup') }}
          </UButton>
        </div>

        <EmptyState
          v-if="groupsStore.list.length === 0 && !groupsStore.loading"
          class="mt-4"
          icon="i-lucide-folder"
          :title="$t('addresses.noGroupsTitle')"
          :description="$t('addresses.noGroupsDescription')"
        />
        <ul v-else class="mt-4 space-y-2.5">
          <li
            v-for="g in groupsStore.list"
            :key="g.id"
            class="soft-card hover-lift"
          >
            <NuxtLink :to="`/groups/${g.id}`" class="flex items-center gap-3.5 p-4">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                <UIcon name="i-lucide-folder" class="size-4.5" />
              </span>
              <span class="min-w-0 flex-1 truncate font-medium text-(--ui-text-highlighted)">{{ g.name }}</span>
              <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed)" />
            </NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
