<script setup lang="ts">
import type { User } from '~/app/types/api'

definePageMeta({ layout: 'default' })
const usersStore = useUsersStore()
const orgsStore = useOrganizationsStore()
const auth = useAuthStore()
const confirm = useConfirm()
const toast = useToast()
const { t } = useI18n()

const email = ref('')
const role = ref<'admin' | 'client'>('client')
const organizationId = ref<number | null>(null)
const creating = ref(false)
/** One modal serves both flows — `mode` only picks the wording. */
const generated = ref<{ email: string; password: string; mode: 'created' | 'reset' } | null>(null)
const editOpen = ref(false)
const editing = ref<User | null>(null)

const roleOptions = computed(() =>
  auth.role === 'super'
    ? [{ label: t('users.roleAdmin'), value: 'admin' }, { label: t('users.roleClient'), value: 'client' }]
    : [{ label: t('users.roleClient'), value: 'client' }]
)
const orgOptions = computed(() =>
  orgsStore.list.map((o) => ({ label: o.name, value: o.id }))
)

onMounted(() => {
  usersStore.refresh()
  orgsStore.refresh()
})

/**
 * Mirrors `requireManageableUser` on the server: super accounts are off-limits
 * to everyone (which also keeps a super from demoting themselves), and an
 * admin may only touch clients. Self-editing falls out of this for free —
 * your own row never satisfies it.
 */
function canManage(u: { role: string }) {
  return u.role !== 'super' && (auth.role === 'super' || u.role === 'client')
}

function canDelete(u: { id: number; role: string }) {
  return canManage(u) && u.id !== auth.user?.id
}

function edit(u: User) {
  editing.value = u
  editOpen.value = true
}

async function resetPassword(u: User) {
  const ok = await confirm({
    title: t('users.resetConfirmTitle', { email: u.email }),
    description: t('users.resetConfirmDescription'),
    confirmLabel: t('users.resetPassword'),
    destructive: true
  })
  if (!ok) return
  try {
    const password = await usersStore.resetPassword(u.id)
    generated.value = { email: u.email, password, mode: 'reset' }
  } catch (e: any) {
    toast.add({
      title: t('users.resetFailed'),
      description: e?.data?.message ?? e?.message,
      color: 'error'
    })
  }
}

function roleLabel(role: string) {
  const map: Record<string, string> = {
    super: t('users.roleSuper'),
    admin: t('users.roleAdmin'),
    client: t('users.roleClient')
  }
  return map[role] ?? role
}

async function add() {
  if (!email.value.trim()) return
  if (role.value === 'client' && organizationId.value == null) {
    toast.add({ title: t('users.pickOrgForClient'), color: 'warning' })
    return
  }
  creating.value = true
  try {
    const password = await usersStore.create({
      email: email.value.trim(),
      role: role.value,
      organizationId: role.value === 'client' ? organizationId.value! : undefined
    })
    generated.value = { email: email.value.trim(), password, mode: 'created' }
    email.value = ''
    organizationId.value = null
  } catch (e: any) {
    toast.add({ title: t('users.createFailed'), description: e?.data?.message ?? e?.message, color: 'error' })
  } finally {
    creating.value = false
  }
}

async function remove(u: { id: number; email: string; role: string }) {
  if (!canDelete(u)) return
  const ok = await confirm({
    title: t('users.deleteConfirmTitle', { email: u.email }),
    description: t('users.deleteConfirmDescription'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await usersStore.remove(u.id)
  } catch (e: any) {
    toast.add({ title: t('users.deleteFailed'), description: e?.data?.message ?? e?.message, color: 'error' })
  }
}

async function copyPassword() {
  if (!generated.value) return
  try {
    await navigator.clipboard.writeText(generated.value.password)
    toast.add({ title: t('users.passwordCopied'), color: 'success' })
  } catch {
    toast.add({ title: t('users.copyFailed'), description: t('users.copyFailedDescription'), color: 'warning' })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('users.pageTitle')"
      :subtitle="$t('users.pageSubtitle')"
      icon="i-lucide-users"
    />

    <div class="soft-card mb-6 grid gap-3 p-5 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
      <UFormField :label="$t('users.emailLabel')">
        <UInput v-model="email" type="email" placeholder="person@company.com" size="lg" class="w-full" @keyup.enter="add" />
      </UFormField>
      <UFormField :label="$t('users.roleLabel')">
        <USelect v-model="role" :items="roleOptions" value-key="value" size="lg" class="w-40" />
      </UFormField>
      <UFormField v-if="role === 'client'" :label="$t('users.organizationLabel')">
        <USelect v-model="organizationId" :items="orgOptions" value-key="value" :placeholder="$t('common.selectPlaceholder')" size="lg" class="w-48" />
      </UFormField>
      <UButton color="primary" size="lg" :loading="creating" @click="add">{{ $t('common.create') }}</UButton>
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
            <span>{{ roleLabel(u.role) }}</span>
            <span v-if="u.organizationName"> · {{ u.organizationName }}</span>
          </p>
        </div>
        <div class="flex shrink-0 gap-1">
          <UButton
            v-if="canManage(u)"
            variant="ghost" color="neutral" size="sm" icon="i-lucide-pencil"
            :aria-label="$t('users.editAriaLabel', { email: u.email })"
            @click="edit(u)"
          />
          <UButton
            v-if="canManage(u)"
            variant="ghost" color="neutral" size="sm" icon="i-lucide-key-round"
            :aria-label="$t('users.resetPasswordAriaLabel', { email: u.email })"
            @click="resetPassword(u)"
          />
          <UButton
            v-if="canDelete(u)"
            variant="ghost" color="error" size="sm" icon="i-lucide-trash-2"
            :aria-label="$t('users.deleteAriaLabel', { email: u.email })"
            @click="remove(u)"
          />
        </div>
      </div>
      <p v-if="!usersStore.loading && usersStore.list.length === 0" class="p-4 text-(--ui-text-muted)">
        {{ $t('users.emptyTitle') }}
      </p>
    </div>

    <UserFormDialog v-model:open="editOpen" :user="editing" />

    <!-- One-time generated-password reveal, shared by create and reset -->
    <UModal
      :open="generated !== null"
      :title="generated?.mode === 'reset' ? $t('users.passwordResetTitle') : $t('users.accountCreatedTitle')"
      @update:open="(v) => { if (!v) generated = null }"
    >
      <template #body>
        <i18n-t
          :keypath="generated?.mode === 'reset' ? 'users.passwordResetBody' : 'users.accountCreatedBody'"
          tag="p"
          class="text-sm text-(--ui-text-muted)"
        >
          <template #email>
            <span class="font-medium text-(--ui-text)">{{ generated?.email }}</span>
          </template>
        </i18n-t>
        <div class="mt-4 flex items-center gap-2 rounded-xl bg-(--ui-bg-elevated) p-3">
          <code class="flex-1 font-mono text-sm">{{ generated?.password }}</code>
          <UButton size="sm" icon="i-lucide-copy" @click="copyPassword">{{ $t('users.copyPassword') }}</UButton>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="soft" @click="generated = null">{{ $t('common.close') }}</UButton>
      </template>
    </UModal>
  </div>
</template>
