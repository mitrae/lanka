<script setup lang="ts">
definePageMeta({ layout: 'default' })
const store = useOrganizationsStore()
const name = ref('')
const creating = ref(false)

onMounted(() => store.refresh())

async function add() {
  if (!name.value.trim()) return
  creating.value = true
  try {
    await store.create(name.value.trim())
    name.value = ''
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      title="Organizations"
      subtitle="Companies that own media. Client accounts see stats for their org."
      icon="i-lucide-briefcase"
    />

    <div class="mb-6 flex max-w-md gap-2">
      <UInput v-model="name" placeholder="New organization name" size="lg" class="flex-1" @keyup.enter="add" />
      <UButton color="primary" size="lg" :loading="creating" @click="add">Add</UButton>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="org in store.list"
        :key="org.id"
        class="soft-card hover-lift flex items-center gap-3.5 p-5"
      >
        <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <UIcon name="i-lucide-briefcase" class="size-5" />
        </span>
        <div class="min-w-0">
          <p class="truncate font-medium text-(--ui-text-highlighted)">{{ org.name }}</p>
          <p class="font-mono text-xs text-(--ui-text-muted)">#{{ org.id }}</p>
        </div>
      </div>
      <p v-if="!store.loading && store.list.length === 0" class="text-(--ui-text-muted)">No organizations yet.</p>
    </div>
  </div>
</template>
