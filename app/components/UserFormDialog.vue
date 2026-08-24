<!-- app/components/UserFormDialog.vue -->
<script setup lang="ts">
import type { UpdateUserBody, User } from '~/app/types/api'

const props = defineProps<{ open: boolean; user: User | null }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'saved', user: User): void
}>()

const store = useUsersStore()
const orgsStore = useOrganizationsStore()
const auth = useAuthStore()
const toast = useToast()
const { t } = useI18n()

const email = ref('')
const role = ref<'admin' | 'client'>('client')
const organizationId = ref<number | null>(null)
const saving = ref(false)

// Only a super can hand out the admin role, matching the create form and the
// server's own check.
const roleOptions = computed(() =>
  auth.role === 'super'
    ? [
        { label: t('users.roleAdmin'), value: 'admin' },
        { label: t('users.roleClient'), value: 'client' }
      ]
    : [{ label: t('users.roleClient'), value: 'client' }]
)
const orgOptions = computed(() => orgsStore.list.map((o) => ({ label: o.name, value: o.id })))

watch(
  () => [props.open, props.user?.id] as const,
  ([open]) => {
    if (!open || !props.user) return
    email.value = props.user.email
    role.value = props.user.role === 'client' ? 'client' : 'admin'
    organizationId.value = props.user.organizationId
  },
  { immediate: true }
)

const needsOrg = computed(() => role.value === 'client')
const canSave = computed(
  () =>
    !saving.value &&
    email.value.trim().length > 0 &&
    (!needsOrg.value || organizationId.value != null)
)

async function save() {
  const target = props.user
  if (!target || !canSave.value) return
  // Send only what actually changed: the server rejects an empty patch, and a
  // no-op email would still trip the unique check against the user's own row.
  const patch: UpdateUserBody = {}
  if (email.value.trim() !== target.email) patch.email = email.value.trim()
  if (role.value !== target.role) patch.role = role.value
  const nextOrg = needsOrg.value ? organizationId.value : null
  if (nextOrg !== target.organizationId) patch.organizationId = nextOrg

  if (Object.keys(patch).length === 0) {
    emit('update:open', false)
    return
  }

  saving.value = true
  try {
    const updated = await store.update(target.id, patch)
    emit('saved', updated)
    emit('update:open', false)
    toast.add({ title: t('users.saved'), color: 'success' })
  } catch (e: any) {
    toast.add({
      title: t('users.saveFailed'),
      description: e?.data?.message ?? e?.message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal :open="open" :title="$t('users.editTitle')" @update:open="(v) => emit('update:open', v)">
    <template #body>
      <div class="grid gap-4">
        <UFormField :label="$t('users.emailLabel')" required>
          <UInput v-model="email" type="email" size="lg" class="w-full" @keyup.enter="save" />
        </UFormField>
        <UFormField :label="$t('users.roleLabel')">
          <USelect v-model="role" :items="roleOptions" value-key="value" size="lg" class="w-full" />
          <!-- Only worth saying when a change is actually about to drop an org. -->
          <p
            v-if="role === 'admin' && user?.organizationId != null"
            class="mt-1.5 text-xs text-(--ui-text-muted)"
          >
            {{ $t('users.roleChangeClearsOrg') }}
          </p>
        </UFormField>
        <UFormField v-if="needsOrg" :label="$t('users.organizationLabel')" required>
          <USelect
            v-model="organizationId"
            :items="orgOptions"
            value-key="value"
            :placeholder="$t('common.selectPlaceholder')"
            size="lg"
            class="w-full"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">
          {{ $t('common.cancel') }}
        </UButton>
        <UButton color="primary" :loading="saving" :disabled="!canSave" @click="save">
          {{ $t('common.save') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
