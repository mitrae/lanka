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
  <div>
    <template #header>Addresses</template>
    <div class="flex items-center justify-between">
      <p class="text-sm text-(--ui-text-muted)">
        Physical locations. Each address can contain multiple groups.
      </p>
      <UButton
        v-if="!creating"
        icon="i-lucide-plus"
        color="primary"
        @click="creating = true"
      >
        New address
      </UButton>
    </div>

    <div
      v-if="creating"
      class="mt-4 flex items-center gap-2 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
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

    <div class="mt-6">
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
      <ul v-else class="space-y-2">
        <li
          v-for="addr in store.list"
          :key="addr.id"
          class="flex items-center justify-between rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4 hover:border-(--ui-border-accented) transition-colors"
        >
          <NuxtLink :to="`/addresses/${addr.id}`" class="flex-1 flex items-center gap-3">
            <UIcon name="i-lucide-building-2" class="size-5 text-(--ui-text-muted)" />
            <div>
              <p class="font-medium">{{ addr.name }}</p>
              <p class="text-xs text-(--ui-text-muted) font-mono">#{{ addr.id }}</p>
            </div>
          </NuxtLink>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-muted)" />
        </li>
      </ul>
    </div>
  </div>
</template>
