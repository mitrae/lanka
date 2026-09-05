<script setup lang="ts">
import type { ConfirmOptions } from '~/app/composables/useConfirm'

const props = defineProps<{ options: ConfirmOptions; modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'resolve', v: boolean): void
}>()

function onCancel() {
  emit('update:modelValue', false)
  emit('resolve', false)
}
function onConfirm() {
  emit('update:modelValue', false)
  emit('resolve', true)
}
</script>

<template>
  <UModal
    :open="modelValue"
    @update:open="(v) => emit('update:modelValue', v)"
    :ui="{ width: 'sm:max-w-md' }"
  >
    <template #content>
      <div class="p-4 sm:p-6">
        <h3 class="text-base font-semibold">{{ options.title }}</h3>
        <p
          v-if="options.description"
          class="mt-2 text-sm text-(--ui-text-muted)"
        >
          {{ options.description }}
        </p>
        <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <UButton variant="ghost" class="justify-center" @click="onCancel">
            {{ options.cancelLabel }}
          </UButton>
          <UButton
            class="justify-center"
            :color="options.destructive ? 'error' : 'primary'"
            @click="onConfirm"
          >
            {{ options.confirmLabel }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
