<!-- app/components/MediaUploadDialog.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'uploaded'): void
}>()

const store = useMediaStore()
const toast = useToast()
const { t } = useI18n()
const files = ref<File[]>([])
const uploading = ref(false)
const dragOver = ref(false)
const quality = ref<'low' | 'standard' | 'high'>('standard')

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  if (!e.dataTransfer) return
  files.value.push(...Array.from(e.dataTransfer.files))
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) {
    files.value.push(...Array.from(input.files))
  }
}

function remove(i: number) {
  files.value.splice(i, 1)
}

function kindOf(f: File): 'video' | 'image' {
  return f.type.startsWith('video/') ? 'video' : 'image'
}

async function upload() {
  if (files.value.length === 0) return
  uploading.value = true
  let ok = 0
  for (const f of files.value) {
    const form = new FormData()
    form.append('file', f)
    form.append('kind', kindOf(f))
    form.append('quality', quality.value)
    try {
      await store.upload(form)
      ok++
    } catch (err: any) {
      toast.add({
        title: t('components.mediaUploadDialog.uploadFailed', { name: f.name }),
        description: err.data?.message ?? err.message,
        color: 'error'
      })
    }
  }
  uploading.value = false
  if (ok > 0) {
    toast.add({
      title: t('components.mediaUploadDialog.uploadedFiles', ok, { named: { n: ok } }),
      color: 'success'
    })
    emit('uploaded')
  }
  files.value = []
  emit('update:modelValue', false)
}
</script>

<template>
  <UModal
    :open="modelValue"
    @update:open="(v) => emit('update:modelValue', v)"
    :ui="{ width: 'sm:max-w-2xl' }"
  >
    <template #content>
      <div class="p-6">
        <h3 class="text-base font-semibold">{{ $t('components.mediaUploadDialog.title') }}</h3>
        <p class="mt-1 text-sm text-(--ui-text-muted)">
          {{ $t('components.mediaUploadDialog.description') }}
        </p>

        <div
          class="mt-4 rounded-lg border-2 border-dashed p-8 text-center transition-colors"
          :class="{
            'border-primary-500 bg-primary-500/5': dragOver,
            'border-(--ui-border) bg-(--ui-bg-elevated)': !dragOver
          }"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop="onDrop"
        >
          <UIcon name="i-lucide-upload-cloud" class="mx-auto size-8 text-(--ui-text-muted)" />
          <i18n-t keypath="components.mediaUploadDialog.dropHint" tag="p" class="mt-2 text-sm">
            <template #browse>
              <label class="cursor-pointer text-primary-500 hover:underline">
                {{ $t('components.mediaUploadDialog.browse') }}
                <input
                  type="file"
                  multiple
                  accept="video/*,image/*"
                  class="hidden"
                  @change="onPick"
                />
              </label>
            </template>
          </i18n-t>
        </div>

        <ul v-if="files.length > 0" class="mt-4 max-h-64 space-y-2 overflow-y-auto">
          <li
            v-for="(f, i) in files"
            :key="i"
            class="flex items-center justify-between rounded border border-(--ui-border) bg-(--ui-bg) p-2 text-sm"
          >
            <div class="flex items-center gap-2 min-w-0">
              <UIcon
                :name="kindOf(f) === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
                class="size-4 text-(--ui-text-muted) shrink-0"
              />
              <span class="truncate">{{ f.name }}</span>
              <span class="text-xs text-(--ui-text-muted) shrink-0">
                {{ (f.size / 1024 / 1024).toFixed(1) }} MB
              </span>
            </div>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="remove(i)"
            />
          </li>
        </ul>

        <div class="mt-4">
          <label class="text-sm font-medium">{{ $t('components.mediaUploadDialog.quality.label') }}</label>
          <USelect
            v-model="quality"
            :items="[
              { label: $t('components.mediaUploadDialog.quality.low'), value: 'low' },
              { label: $t('components.mediaUploadDialog.quality.standard'), value: 'standard' },
              { label: $t('components.mediaUploadDialog.quality.high'), value: 'high' },
            ]"
            value-key="value"
            label-key="label"
            class="mt-1 w-full"
          />
          <p class="mt-1 text-xs text-(--ui-text-muted)">{{ $t('components.mediaUploadDialog.quality.hint') }}</p>
        </div>

        <div class="mt-6 flex justify-end gap-2">
          <UButton variant="ghost" @click="emit('update:modelValue', false)">
            {{ $t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            :loading="uploading"
            :disabled="files.length === 0"
            @click="upload"
          >
            {{ files.length > 0 ? $t('components.mediaUploadDialog.uploadButtonCount', { n: files.length }) : $t('components.mediaUploadDialog.uploadButton') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
