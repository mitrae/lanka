<script setup lang="ts">
import type { Organization } from '~/app/types/api'

definePageMeta({ layout: 'default' })
const store = useOrganizationsStore()
const confirm = useConfirm()
const toast = useToast()
const { t } = useI18n()

const name = ref('')
const creating = ref(false)
const dialogOpen = ref(false)
const editing = ref<Organization | null>(null)

onMounted(() => store.refresh())

/** Quick-add keeps the original one-field flow; the dialog covers the rest. */
async function add() {
  if (!name.value.trim()) return
  creating.value = true
  try {
    await store.create({ name: name.value.trim() })
    name.value = ''
  } catch (e: any) {
    toast.add({
      title: t('organizations.createFailed'),
      description: e?.data?.message ?? e?.message,
      color: 'error'
    })
  } finally {
    creating.value = false
  }
}

function openNew() {
  editing.value = null
  dialogOpen.value = true
}

function edit(org: Organization) {
  editing.value = org
  dialogOpen.value = true
}

async function remove(org: Organization) {
  const attached = org.mediaCount + org.userCount
  const ok = await confirm({
    title: t('organizations.deleteConfirmTitle', { name: org.name }),
    description: attached
      ? t('organizations.deleteConfirmAttached', {
          media: t('organizations.mediaCount', org.mediaCount, { n: org.mediaCount }),
          users: t('organizations.userCount', org.userCount, { n: org.userCount })
        })
      : t('organizations.deleteConfirmEmpty'),
    confirmLabel: t('common.delete'),
    destructive: true
  })
  if (!ok) return
  try {
    await store.remove(org.id, { force: attached > 0 })
    toast.add({ title: t('organizations.deleted'), color: 'success' })
  } catch (e: any) {
    toast.add({
      title: t('organizations.deleteFailed'),
      description: e?.data?.message ?? e?.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="reveal">
    <PageHeader
      :title="$t('organizations.pageTitle')"
      :subtitle="$t('organizations.pageSubtitle')"
      icon="i-lucide-briefcase"
    >
      <template #actions>
        <UButton color="primary" icon="i-lucide-plus" @click="openNew">
          {{ $t('organizations.addTitle') }}
        </UButton>
      </template>
    </PageHeader>

    <div class="mb-6 flex max-w-md gap-2">
      <UInput
        v-model="name"
        :placeholder="$t('organizations.namePlaceholder')"
        size="lg"
        class="flex-1"
        @keyup.enter="add"
      />
      <UButton color="primary" size="lg" :loading="creating" @click="add">
        {{ $t('common.add') }}
      </UButton>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="org in store.list"
        :key="org.id"
        class="soft-card hover-lift flex flex-col gap-3 p-5"
      >
        <div class="flex items-start gap-3.5">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <UIcon name="i-lucide-briefcase" class="size-5" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-(--ui-text-highlighted)">{{ org.name }}</p>
            <p class="font-mono text-xs text-(--ui-text-muted)">#{{ org.id }}</p>
          </div>
          <div class="flex shrink-0 gap-1">
            <UButton
              variant="ghost" color="neutral" size="xs" icon="i-lucide-pencil"
              :aria-label="$t('organizations.editAriaLabel', { name: org.name })"
              @click="edit(org)"
            />
            <UButton
              variant="ghost" color="error" size="xs" icon="i-lucide-trash-2"
              :aria-label="$t('organizations.deleteAriaLabel', { name: org.name })"
              @click="remove(org)"
            />
          </div>
        </div>

        <dl v-if="org.phone || org.email" class="grid gap-1 text-sm">
          <div v-if="org.phone" class="flex items-center gap-2 text-(--ui-text-muted)">
            <UIcon name="i-lucide-phone" class="size-3.5 shrink-0" />
            <a :href="`tel:${org.phone}`" class="truncate hover:text-(--ui-text)">{{ org.phone }}</a>
          </div>
          <div v-if="org.email" class="flex items-center gap-2 text-(--ui-text-muted)">
            <UIcon name="i-lucide-mail" class="size-3.5 shrink-0" />
            <a :href="`mailto:${org.email}`" class="truncate hover:text-(--ui-text)">{{ org.email }}</a>
          </div>
        </dl>

        <p v-if="org.notes" class="line-clamp-3 text-sm text-(--ui-text-muted)" :title="org.notes">
          {{ org.notes }}
        </p>

        <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
          <UBadge size="sm" color="neutral" variant="soft">
            <UIcon name="i-lucide-image" class="size-3" />
            {{ $t('organizations.mediaCount', org.mediaCount, { n: org.mediaCount }) }}
          </UBadge>
          <UBadge v-if="org.userCount > 0" size="sm" color="neutral" variant="soft">
            <UIcon name="i-lucide-users" class="size-3" />
            {{ $t('organizations.userCount', org.userCount, { n: org.userCount }) }}
          </UBadge>
        </div>
      </div>
      <p v-if="!store.loading && store.list.length === 0" class="text-(--ui-text-muted)">
        {{ $t('organizations.emptyTitle') }}
      </p>
    </div>

    <OrganizationFormDialog v-model:open="dialogOpen" :organization="editing" />
  </div>
</template>
