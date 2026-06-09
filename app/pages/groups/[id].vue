<!-- app/pages/groups/[id].vue -->
<script setup lang="ts">
import { useGroupsStore } from '~/app/stores/groups'
import { useAddressesStore } from '~/app/stores/addresses'
import { useDevicesStore } from '~/app/stores/devices'
import { useApiClient } from '~/app/composables/useApiClient'

definePageMeta({ layout: 'default' })

const { t } = useI18n()

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
      title: t('groups.loadFailed'),
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
    toast.add({ title: t('groups.saved'), color: 'success' })
  } catch (err: any) {
    toast.add({
      title: t('groups.saveFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}

async function remove() {
  if (!group.value) return
  const ok = await confirm({
    title: t('groups.deleteConfirmTitle', { name: group.value.name }),
    description: t('groups.deleteConfirmDescription'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await groupsStore.delete(group.value.id)
    router.push('/groups')
  } catch (err: any) {
    toast.add({
      title: t('groups.deleteFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <NuxtLink
      to="/groups"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-(--ui-text-muted) transition-colors hover:text-(--ui-text)"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" /> {{ $t('groups.pageTitle') }}
    </NuxtLink>

    <div v-if="!group">
      <USkeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <section class="soft-card p-6">
        <div class="flex items-start justify-between">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-indigo-500/10 p-3 text-indigo-600 dark:text-indigo-400">
              <UIcon name="i-lucide-folder" class="size-6" />
            </div>
            <div>
              <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
                {{ $t('groups.groupLabel') }}
              </p>
              <template v-if="!editing">
                <h2 class="mt-1 text-2xl font-semibold text-(--ui-text-highlighted)">{{ group.name }}</h2>
                <p class="mt-1 text-sm text-(--ui-text-muted)">
                  {{ $t('groups.inAddress', { name: addressesStore.list.find((a) => a.id === group!.addressId)?.name ?? '?' }) }}
                </p>
              </template>
              <template v-else>
                <div class="mt-1 flex w-80 flex-col gap-2">
                  <UInput v-model="editName" />
                  <USelectMenu
                    v-model="editAddressId"
                    :items="addressItems"
                    value-key="value"
                  />
                </div>
              </template>
            </div>
          </div>
          <div class="flex gap-2">
            <template v-if="!editing">
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
                  editName = group!.name;
                  editAddressId = group!.addressId
                "
              >
                {{ $t('common.cancel') }}
              </UButton>
            </template>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <h3 class="text-sm font-semibold text-(--ui-text-highlighted)">{{ $t('groups.devicesInGroup') }}</h3>
        <EmptyState
          v-if="devicesStore.list.length === 0"
          class="mt-4"
          icon="i-lucide-tv"
          :title="$t('groups.noDevicesTitle')"
          :description="$t('groups.noDevicesDescription')"
        />
        <ul v-else class="mt-4 space-y-2.5">
          <li
            v-for="d in devicesStore.list"
            :key="d.id"
            class="soft-card hover-lift"
          >
            <NuxtLink :to="`/devices/${d.id}`" class="flex items-center gap-3.5 p-4">
              <StatusDot :status="d.status" />
              <span class="font-medium text-(--ui-text-highlighted)">{{ d.name ?? $t('groups.unnamed') }}</span>
              <code class="ml-auto max-w-xs truncate font-mono text-xs text-(--ui-text-dimmed)">
                {{ d.id }}
              </code>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
