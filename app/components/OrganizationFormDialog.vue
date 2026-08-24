<!-- app/components/OrganizationFormDialog.vue -->
<script setup lang="ts">
import type { Organization, OrganizationInput } from '~/app/types/api'

const props = defineProps<{
  open: boolean
  /** null = create a new organization, otherwise edit this one. */
  organization: Organization | null
}>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'saved', org: Organization): void
}>()

const store = useOrganizationsStore()
const toast = useToast()
const { t } = useI18n()

const form = reactive({ name: '', phone: '', email: '', notes: '' })
const saving = ref(false)

// Re-seed on every open so a cancelled edit never leaks into the next one.
watch(
  () => [props.open, props.organization?.id] as const,
  ([open]) => {
    if (!open) return
    const o = props.organization
    form.name = o?.name ?? ''
    form.phone = o?.phone ?? ''
    form.email = o?.email ?? ''
    form.notes = o?.notes ?? ''
  },
  { immediate: true }
)

const canSave = computed(() => form.name.trim().length > 0 && !saving.value)

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    // Sent verbatim: the server trims and collapses blank strings to NULL.
    const payload: OrganizationInput = {
      name: form.name,
      phone: form.phone,
      email: form.email,
      notes: form.notes
    }
    const org = props.organization
      ? await store.update(props.organization.id, payload)
      : await store.create({ ...payload, name: form.name })
    emit('saved', org)
    emit('update:open', false)
  } catch (e: any) {
    toast.add({
      title: props.organization ? t('organizations.saveFailed') : t('organizations.createFailed'),
      description: e?.data?.message ?? e?.message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="organization ? $t('organizations.editTitle') : $t('organizations.addTitle')"
    @update:open="(v) => emit('update:open', v)"
  >
    <template #body>
      <div class="grid gap-4">
        <UFormField :label="$t('organizations.nameLabel')" required>
          <UInput v-model="form.name" size="lg" class="w-full" autofocus @keyup.enter="save" />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="$t('organizations.phoneLabel')">
            <UInput v-model="form.phone" type="tel" size="lg" class="w-full" @keyup.enter="save" />
          </UFormField>
          <UFormField :label="$t('organizations.emailLabel')">
            <UInput v-model="form.email" type="email" size="lg" class="w-full" @keyup.enter="save" />
          </UFormField>
        </div>
        <UFormField :label="$t('organizations.notesLabel')">
          <UTextarea
            v-model="form.notes"
            :rows="4"
            :placeholder="$t('organizations.notesPlaceholder')"
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
          {{ organization ? $t('common.save') : $t('common.create') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
