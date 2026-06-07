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
  <div>
    <h1 class="mb-1 text-3xl font-bold tracking-tight">Organizations</h1>
    <p class="mb-8 text-sm text-(--ui-text-muted)">Companies that own media. Client accounts see stats for their org.</p>

    <div class="mb-6 flex max-w-md gap-2">
      <UInput v-model="name" placeholder="New organization name" size="lg" class="flex-1" @keyup.enter="add" />
      <UButton color="neutral" size="lg" class="rounded-xl" :loading="creating" @click="add">Add</UButton>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="org in store.list"
        :key="org.id"
        class="rounded-2xl border border-black/5 bg-white/80 p-5 shadow-sm"
      >
        <p class="font-medium">{{ org.name }}</p>
        <p class="mt-1 text-xs text-(--ui-text-muted)">#{{ org.id }}</p>
      </div>
      <p v-if="!store.loading && store.list.length === 0" class="text-(--ui-text-muted)">No organizations yet.</p>
    </div>
  </div>
</template>
