<!-- app/components/EmptyState.vue -->
<script setup lang="ts">
defineProps<{
  icon?: string
  title: string
  description?: string
}>()
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-(--ui-border) p-12 text-center"
  >
    <UIcon
      v-if="icon"
      :name="icon"
      class="size-10 text-(--ui-text-muted)"
    />
    <div>
      <p class="text-sm font-medium">{{ title }}</p>
      <p
        v-if="description"
        class="mt-1 text-sm text-(--ui-text-muted)"
      >
        {{ description }}
      </p>
    </div>
    <slot />
  </div>
</template>
