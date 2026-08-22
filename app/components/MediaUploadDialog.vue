<!-- app/components/MediaUploadDialog.vue -->
<script setup lang="ts">
import { useMediaStore } from '~/app/stores/media'
import { kindOf } from './MediaUploadDialog.logic'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'uploaded'): void
}>()

type ItemState = 'idle' | 'uploading' | 'queued' | 'failed'
interface Item {
  file: File
  kind: 'video' | 'image'
  state: ItemState
  progress: number // 0..100
  error?: string
}

const store = useMediaStore()
const toast = useToast()
const { t } = useI18n()
const items = ref<Item[]>([])
const uploading = ref(false)
const dragOver = ref(false)
const quality = ref<'low' | 'standard' | 'high'>('standard')
let controller: AbortController | null = null

function add(files: Iterable<File>) {
  for (const f of files) items.value.push({ file: f, kind: kindOf(f), state: 'idle', progress: 0 })
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  if (e.dataTransfer) add(Array.from(e.dataTransfer.files))
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) add(Array.from(input.files))
  input.value = ''
}

function remove(i: number) {
  if (uploading.value) return
  items.value.splice(i, 1)
}

async function upload() {
  const todo = items.value.filter((it) => it.state !== 'queued')
  if (todo.length === 0 || uploading.value) return
  uploading.value = true
  controller = new AbortController()
  let queued = 0
  for (const it of todo) {
    it.state = 'uploading'
    it.progress = 0
    it.error = undefined
    try {
      await store.startUpload(it.file, {
        kind: it.kind,
        quality: quality.value,
        signal: controller.signal,
        onProgress: (p) => {
          it.progress = Math.round(p * 100)
        }
      })
      it.state = 'queued'
      it.progress = 100
      queued++
    } catch (err: any) {
      it.state = 'failed'
      it.error = err.data?.message ?? err.message
      if (err.aborted) break
      toast.add({
        title: t('components.mediaUploadDialog.uploadFailed', { name: it.file.name }),
        description: it.error,
        color: 'error'
      })
    }
  }
  uploading.value = false
  controller = null
  if (queued > 0) {
    toast.add({
      title: t('components.mediaUploadDialog.queuedFiles', queued, { named: { n: queued } }),
      color: 'success'
    })
    emit('uploaded')
  }
  if (items.value.every((it) => it.state === 'queued')) {
    items.value = []
    emit('update:modelValue', false)
  } else {
    // Keep failed/aborted rows so the user can retry them.
    items.value = items.value.filter((it) => it.state !== 'queued')
  }
}

function cancel() {
  if (uploading.value) {
    controller?.abort()
    return
  }
  emit('update:modelValue', false)
}

// Escape / backdrop / X all arrive here. While a transfer is running the modal
// is marked non-dismissible, but route any close attempt through cancel() anyway
// so an aborted XHR never outlives a hidden dialog.
function onOpenChange(open: boolean) {
  if (open) return emit('update:modelValue', true)
  // Drop stale rows (e.g. previously failed items) before closing so they
  // don't reappear pre-populated the next time the dialog opens. Only when
  // not uploading — cancel() itself decides whether this close actually
  // goes through (an in-flight transfer aborts instead).
  if (!uploading.value) items.value = []
  cancel()
}

const pendingCount = computed(() => items.value.filter((it) => it.state !== 'queued').length)
</script>

<template>
  <UModal
    :open="modelValue"
    :dismissible="!uploading"
    @update:open="onOpenChange"
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

        <ul v-if="items.length > 0" class="mt-4 max-h-64 space-y-2 overflow-y-auto">
          <li
            v-for="(it, i) in items"
            :key="i"
            class="rounded border border-(--ui-border) bg-(--ui-bg) p-2 text-sm"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 min-w-0">
                <UIcon
                  :name="it.kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'"
                  class="size-4 text-(--ui-text-muted) shrink-0"
                />
                <span class="truncate">{{ it.file.name }}</span>
                <span class="text-xs text-(--ui-text-muted) shrink-0">
                  {{ (it.file.size / 1024 / 1024).toFixed(1) }} MB
                </span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span v-if="it.state === 'uploading'" class="text-xs text-(--ui-text-muted)">
                  {{ $t('components.mediaUploadDialog.uploading', { pct: it.progress }) }}
                </span>
                <UBadge v-else-if="it.state === 'queued'" size="sm" color="success" variant="soft">
                  {{ $t('components.mediaUploadDialog.queued') }}
                </UBadge>
                <UBadge v-else-if="it.state === 'failed'" size="sm" color="error" variant="soft" :title="it.error">
                  {{ $t('components.mediaUploadDialog.failed') }}
                </UBadge>
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="uploading"
                  @click="remove(i)"
                />
              </div>
            </div>
            <UProgress v-if="it.state === 'uploading'" :model-value="it.progress" :max="100" size="xs" class="mt-2" />
            <p v-if="it.state === 'failed' && it.error" class="mt-1 text-xs text-(--ui-error)">{{ it.error }}</p>
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
          <UButton variant="ghost" @click="cancel">
            {{ uploading ? $t('components.mediaUploadDialog.cancelUpload') : $t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            :loading="uploading"
            :disabled="pendingCount === 0 || uploading"
            @click="upload"
          >
            {{ pendingCount > 0 ? $t('components.mediaUploadDialog.uploadButtonCount', { n: pendingCount }) : $t('components.mediaUploadDialog.uploadButton') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
