<!-- app/pages/groups/index.vue -->
<script setup lang="ts">
import { useGroupsStore } from '~/app/stores/groups'
import { useAddressesStore } from '~/app/stores/addresses'

definePageMeta({ layout: 'default' })

const { t } = useI18n()

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
  { label: t('groups.allAddresses'), value: null },
  ...addressesStore.list.map((a) => ({ label: a.name, value: a.id }))
])

function addressName(id: number) {
  return addressesStore.list.find((a) => a.id === id)?.name ?? `#${id}`
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('groups.pageTitle')"
      :subtitle="$t('groups.pageSubtitle')"
      icon="i-lucide-folder"
    >
      <template #actions>
        <USelectMenu
          v-model="addressFilter"
          :items="addressItems"
          value-key="value"
          :placeholder="$t('groups.filterByAddress')"
          class="w-full sm:w-64"
        />
      </template>
    </PageHeader>

    <USkeleton
      v-if="groupsStore.loading && groupsStore.list.length === 0"
      class="h-24 w-full"
    />
    <EmptyState
      v-else-if="groupsStore.list.length === 0"
      icon="i-lucide-folder"
      :title="$t('groups.emptyTitle')"
      :description="$t('groups.emptyDescription')"
    />
    <ul v-else class="space-y-2.5">
      <li
        v-for="g in groupsStore.list"
        :key="g.id"
        class="soft-card hover-lift"
      >
        <NuxtLink :to="`/groups/${g.id}`" class="flex items-center gap-3.5 p-4">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <UIcon name="i-lucide-folder" class="size-5" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-(--ui-text-highlighted)">{{ g.name }}</p>
            <p class="text-xs text-(--ui-text-muted)">
              {{ $t('groups.inAddress', { name: addressName(g.addressId) }) }}
            </p>
          </div>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed)" />
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
