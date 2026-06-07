<!-- app/components/PageHeader.vue -->
<!-- Consistent page header: title + optional subtitle + actions slot. -->
<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
  icon?: string
}>()
</script>

<template>
  <header class="mb-8 flex items-end justify-between gap-4">
    <div class="min-w-0">
      <div class="flex items-center gap-3">
        <span
          v-if="icon"
          class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
        >
          <UIcon :name="icon" class="size-5" />
        </span>
        <h1 class="truncate text-3xl font-bold tracking-tight text-(--ui-text-highlighted)">
          {{ title }}
        </h1>
      </div>
      <p v-if="subtitle" class="mt-2 text-sm text-(--ui-text-muted)">{{ subtitle }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
