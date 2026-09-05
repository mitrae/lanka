<!-- app/components/AssignmentPicker.vue -->
<script setup lang="ts">
import { usePlaylistsStore } from '~/app/stores/playlists'
import { useApiClient } from '~/app/composables/useApiClient'

const props = defineProps<{
  target: 'device' | 'group' | 'address'
  targetId: string | number
  currentPlaylistId: number | null
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const playlistsStore = usePlaylistsStore()
const api = useApiClient()
const toast = useToast()
const { t } = useI18n()

const selected = ref<number | null>(props.currentPlaylistId)

onMounted(() => {
  if (playlistsStore.list.length === 0) playlistsStore.refresh()
})

watch(
  () => props.currentPlaylistId,
  (v) => (selected.value = v)
)

const items = computed(() => [
  { label: t('components.assignmentPicker.noDirectAssignment'), value: null },
  ...playlistsStore.list.map((p) => ({ label: p.name, value: p.id }))
])

async function apply() {
  try {
    if (selected.value === null) {
      switch (props.target) {
        case 'device':
          await api.unassignDevice(props.targetId as string)
          break
        case 'group':
          await api.unassignGroup(props.targetId as number)
          break
        case 'address':
          await api.unassignAddress(props.targetId as number)
          break
      }
      toast.add({ title: t('components.assignmentPicker.assignmentCleared'), color: 'success' })
    } else {
      switch (props.target) {
        case 'device':
          await api.assignDeviceToPlaylist(props.targetId as string, {
            playlistId: selected.value
          })
          break
        case 'group':
          await api.assignGroupToPlaylist(props.targetId as number, {
            playlistId: selected.value
          })
          break
        case 'address':
          await api.assignAddressToPlaylist(props.targetId as number, {
            playlistId: selected.value
          })
          break
      }
      toast.add({ title: t('components.assignmentPicker.assignmentUpdated'), color: 'success' })
    }
    emit('changed')
  } catch (err: any) {
    toast.add({
      title: t('components.assignmentPicker.updateFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
    <USelectMenu
      v-model="selected"
      :items="items"
      value-key="value"
      class="w-full sm:flex-1"
    />
    <UButton
      color="primary"
      class="w-full justify-center sm:w-auto"
      :disabled="selected === props.currentPlaylistId"
      @click="apply"
    >
      {{ $t('components.assignmentPicker.apply') }}
    </UButton>
  </div>
</template>
