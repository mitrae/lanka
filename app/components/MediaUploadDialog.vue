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
const files = ref<File[]>([])
const uploading = ref(false)
const dragOver = ref(false)

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
    try {
      await store.upload(form)
      ok++
    } catch (err: any) {
      toast.add({
        title: `Upload failed: ${f.name}`,
        description: err.data?.message ?? err.message,
        color: 'error'
      })
    }
  }
  uploading.value = false
  if (ok > 0) {
    toast.add({
      title: `Uploaded ${ok} file${ok > 1 ? 's' : ''}`,
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
        <h3 class="text-base font-semibold">Upload media</h3>
        <p class="mt-1 text-sm text-(--ui-text-muted)">
          Videos and images. Max 500 MB per file. Duplicate content is deduplicated by sha256.
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
          <p class="mt-2 text-sm">
            Drop files here, or
            <label class="cursor-pointer text-primary-500 hover:underline">
              browse
              <input
                type="file"
                multiple
                accept="video/*,image/*"
                class="hidden"
                @change="onPick"
              />
            </label>
          </p>
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

        <div class="mt-6 flex justify-end gap-2">
          <UButton variant="ghost" @click="emit('update:modelValue', false)">
            Cancel
          </UButton>
          <UButton
            color="primary"
            :loading="uploading"
            :disabled="files.length === 0"
            @click="upload"
          >
            Upload {{ files.length > 0 ? `(${files.length})` : '' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
