<!-- app/pages/groups/index.vue -->
<script setup lang="ts">
import { useGroupsStore } from '~/app/stores/groups'
import { useAddressesStore } from '~/app/stores/addresses'

definePageMeta({ layout: 'default' })

const groupsStore = useGroupsStore()
const addressesStore = useAddressesStore()
const route = useRoute()
const router = useRouter()

const addressFilter = ref<number | null>(
  route.query.addressId ? Number(route.query.addressId) : null
)

watch(addressFilter, (v) => {
  router.replace({
    query: { ...route.query, addressId: v ?? undefined }
  })
  groupsStore.refresh({ addressId: v ?? undefined })
})

onMounted(async () => {
  await Promise.all([
    addressesStore.refresh(),
    groupsStore.refresh({ addressId: addressFilter.value ?? undefined })
  ])
})

const addressItems = computed(() => [
  { label: 'All addresses', value: null },
  ...addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
])

function addressName(id: number) {
  return addressesStore.list.find((a) => a.id === id)?.name ?? `#${id}`
}
</script>

<template>
  <div>
    <div class="flex items-center gap-3">
      <USelectMenu
        v-model="addressFilter"
        :items="addressItems"
        value-key="value"
        placeholder="Filter by address"
        class="w-64"
      />
    </div>

    <div class="mt-6">
      <USkeleton
        v-if="groupsStore.loading && groupsStore.list.length === 0"
        class="h-24 w-full"
      />
      <EmptyState
        v-else-if="groupsStore.list.length === 0"
        icon="i-lucide-folder"
        title="No groups match"
        description="Create groups from an address detail page."
      />
      <ul v-else class="space-y-2">
        <li
          v-for="g in groupsStore.list"
          :key="g.id"
          class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
        >
          <NuxtLink :to="`/groups/${g.id}`" class="flex-1 flex items-center gap-3">
            <UIcon name="i-lucide-folder" class="size-5 text-(--ui-text-muted)" />
            <div>
              <p class="font-medium">{{ g.name }}</p>
              <p class="text-xs text-(--ui-text-muted)">
                in {{ addressName(g.addressId) }}
              </p>
            </div>
          </NuxtLink>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
        </li>
      </ul>
    </div>
  </div>
</template>
