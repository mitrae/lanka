<!-- app/pages/addresses/index.vue -->
<script setup lang="ts">
import { useAddressesStore } from '~/app/stores/addresses'

definePageMeta({ layout: 'default' })

const store = useAddressesStore()
const toast = useToast()
const creating = ref(false)
const newName = ref('')

onMounted(() => store.refresh())

async function createAddress() {
  if (!newName.value.trim()) return
  try {
    await store.create({ name: newName.value.trim() })
    toast.add({ title: 'Address created', color: 'success' })
    newName.value = ''
    creating.value = false
  } catch (err: any) {
    toast.add({
      title: 'Create failed',
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      title="Addresses"
      subtitle="Physical locations. Each address can contain multiple groups."
      icon="i-lucide-building-2"
    >
      <template #actions>
        <UButton
          v-if="!creating"
          icon="i-lucide-plus"
          color="primary"
          @click="creating = true"
        >
          New address
        </UButton>
      </template>
    </PageHeader>

    <div
      v-if="creating"
      class="soft-card mb-4 flex items-center gap-2 p-4"
    >
      <UInput
        v-model="newName"
        placeholder="Address name (e.g. Mechnikova Clinic)"
        class="flex-1"
        autofocus
        @keyup.enter="createAddress"
      />
      <UButton color="primary" @click="createAddress">Create</UButton>
      <UButton
        color="neutral"
        variant="ghost"
        @click="creating = false; newName = ''"
      >
        Cancel
      </UButton>
    </div>

    <USkeleton
      v-if="store.loading && store.list.length === 0"
      class="h-24 w-full"
    />
    <EmptyState
      v-else-if="store.list.length === 0"
      icon="i-lucide-building-2"
      title="No addresses yet"
      description="Create your first address to start organizing devices."
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
            <p class="font-medium text-(--ui-text-highlighted)">{{ addr.name }}</p>
            <p class="font-mono text-xs text-(--ui-text-muted)">#{{ addr.id }}</p>
          </div>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed)" />
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
