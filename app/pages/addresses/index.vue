<!-- app/pages/addresses/index.vue -->
<script setup lang="ts">
import { useAddressesStore } from '~/app/stores/addresses'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const store = useAddressesStore()
const toast = useToast()
const creating = ref(false)
const newName = ref('')

onMounted(() => store.refresh())

async function createAddress() {
  if (!newName.value.trim()) return
  try {
    await store.create({ name: newName.value.trim() })
    toast.add({ title: t('addresses.created'), color: 'success' })
    newName.value = ''
    creating.value = false
  } catch (err: any) {
    toast.add({
      title: t('addresses.createFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('addresses.pageTitle')"
      :subtitle="$t('addresses.pageSubtitle')"
      icon="i-lucide-building-2"
    >
      <template #actions>
        <UButton
          v-if="!creating"
          icon="i-lucide-plus"
          color="primary"
          @click="creating = true"
        >
          {{ $t('addresses.newAddress') }}
        </UButton>
      </template>
    </PageHeader>

    <div
      v-if="creating"
      class="soft-card mb-4 flex flex-col gap-2 p-4 sm:flex-row sm:items-center"
    >
      <UInput
        v-model="newName"
        :placeholder="$t('addresses.namePlaceholder')"
        class="w-full sm:flex-1"
        autofocus
        @keyup.enter="createAddress"
      />
      <UButton color="primary" @click="createAddress">{{ $t('common.create') }}</UButton>
      <UButton
        color="neutral"
        variant="ghost"
        @click="creating = false; newName = ''"
      >
        {{ $t('common.cancel') }}
      </UButton>
    </div>

    <USkeleton
      v-if="store.loading && store.list.length === 0"
      class="h-24 w-full"
    />
    <EmptyState
      v-else-if="store.list.length === 0"
      icon="i-lucide-building-2"
      :title="$t('addresses.emptyTitle')"
      :description="$t('addresses.emptyDescription')"
    />
    <ul v-else class="space-y-2.5">
      <li
        v-for="addr in store.list"
        :key="addr.id"
        class="soft-card hover-lift"
      >
        <NuxtLink :to="`/addresses/${addr.id}`" class="flex items-center gap-3.5 p-4">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <UIcon name="i-lucide-building-2" class="size-5" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-(--ui-text-highlighted)">{{ addr.name }}</p>
            <p class="font-mono text-xs text-(--ui-text-muted)">#{{ addr.id }}</p>
          </div>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed)" />
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
