<script setup lang="ts">
definePageMeta({ layout: 'default' })
const usersStore = useUsersStore()
const orgsStore = useOrganizationsStore()
const auth = useAuthStore()
const confirm = useConfirm()
const toast = useToast()

const email = ref('')
const role = ref<'admin' | 'client'>('client')
const organizationId = ref<number | null>(null)
const creating = ref(false)
const generated = ref<{ email: string; password: string } | null>(null)

const roleOptions = computed(() =>
  auth.role === 'super'
    ? [{ label: 'Admin', value: 'admin' }, { label: 'Client', value: 'client' }]
    : [{ label: 'Client', value: 'client' }]
)
const orgOptions = computed(() =>
  orgsStore.list.map((o) => ({ label: o.name, value: o.id }))
)

onMounted(() => {
  usersStore.refresh()
  orgsStore.refresh()
})

function canDelete(u: { id: number; role: string }) {
  return u.id !== auth.user?.id && u.role !== 'super'
}

async function add() {
  if (!email.value.trim()) return
  if (role.value === 'client' && organizationId.value == null) {
    toast.add({ title: 'Pick an organization for the client', color: 'warning' })
    return
  }
  creating.value = true
  try {
    const password = await usersStore.create({
      email: email.value.trim(),
      role: role.value,
      organizationId: role.value === 'client' ? organizationId.value! : undefined
    })
    generated.value = { email: email.value.trim(), password }
    email.value = ''
    organizationId.value = null
  } catch (e: any) {
    toast.add({ title: 'Could not create user', description: e?.data?.message ?? e?.message, color: 'error' })
  } finally {
    creating.value = false
  }
}

async function remove(u: { id: number; email: string; role: string }) {
  if (!canDelete(u)) return
  const ok = await confirm({
    title: `Delete ${u.email}?`,
    description: 'Their sessions end immediately. This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  try {
    await usersStore.remove(u.id)
  } catch (e: any) {
    toast.add({ title: 'Could not delete user', description: e?.data?.message ?? e?.message, color: 'error' })
  }
}

async function copyPassword() {
  if (!generated.value) return
  try {
    await navigator.clipboard.writeText(generated.value.password)
    toast.add({ title: 'Password copied', color: 'success' })
  } catch {
    toast.add({ title: 'Copy failed', description: 'Select and copy the password manually.', color: 'warning' })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      title="Users"
      subtitle="Create admins and client accounts. Clients see only their organization's portal."
      icon="i-lucide-users"
    />

    <div class="soft-card mb-6 grid gap-3 p-5 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
      <UFormField label="Email">
        <UInput v-model="email" type="email" placeholder="person@company.com" size="lg" class="w-full" @keyup.enter="add" />
      </UFormField>
      <UFormField label="Role">
        <USelect v-model="role" :items="roleOptions" value-key="value" size="lg" class="w-40" />
      </UFormField>
      <UFormField v-if="role === 'client'" label="Organization">
        <USelect v-model="organizationId" :items="orgOptions" value-key="value" placeholder="Select…" size="lg" class="w-48" />
      </UFormField>
      <UButton color="primary" size="lg" :loading="creating" @click="add">Create</UButton>
    </div>

    <div class="soft-card divide-y divide-(--ui-border)">
      <div
        v-for="u in usersStore.list"
        :key="u.id"
        class="flex items-center gap-3.5 p-4"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
          {{ u.email.slice(0, 2).toUpperCase() }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium text-(--ui-text-highlighted)">{{ u.email }}</p>
          <p class="text-xs text-(--ui-text-muted)">
            <span class="capitalize">{{ u.role }}</span>
            <span v-if="u.organizationName"> · {{ u.organizationName }}</span>
          </p>
        </div>
        <UButton
          v-if="canDelete(u)"
          variant="ghost" color="error" size="sm" icon="i-lucide-trash-2"
          :aria-label="`Delete ${u.email}`"
          @click="remove(u)"
        />
      </div>
      <p v-if="!usersStore.loading && usersStore.list.length === 0" class="p-4 text-(--ui-text-muted)">
        No users yet.
      </p>
    </div>

    <!-- One-time generated-password reveal -->
    <UModal :open="generated !== null" title="Account created" @update:open="(v) => { if (!v) generated = null }">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">
          Share this one-time password with <span class="font-medium text-(--ui-text)">{{ generated?.email }}</span>.
          It is shown only once — they can change it later via "Forgot password".
        </p>
        <div class="mt-4 flex items-center gap-2 rounded-xl bg-(--ui-bg-elevated) p-3">
          <code class="flex-1 font-mono text-sm">{{ generated?.password }}</code>
          <UButton size="sm" icon="i-lucide-copy" @click="copyPassword">Copy</UButton>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="soft" @click="generated = null">Done</UButton>
      </template>
    </UModal>
  </div>
</template>
