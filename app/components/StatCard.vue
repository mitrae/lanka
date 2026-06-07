<!-- app/components/StatCard.vue -->
<script setup lang="ts">
defineProps<{
  label: string
  value: number | string
  icon?: string
  hint?: string
  tone?: 'neutral' | 'emerald' | 'amber' | 'rose' | 'blue'
}>()
</script>

<template>
  <div class="soft-card hover-lift p-5">
    <div class="flex items-center gap-3">
      <div
        v-if="icon"
        class="rounded-xl p-2.5"
        :class="{
          'bg-(--ui-bg-accented) text-(--ui-text-muted)': !tone || tone === 'neutral',
          'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400': tone === 'emerald',
          'bg-amber-500/10 text-amber-600 dark:text-amber-400': tone === 'amber',
          'bg-rose-500/10 text-rose-600 dark:text-rose-400': tone === 'rose',
          'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400': tone === 'blue'
        }"
      >
        <UIcon :name="icon" class="size-5" />
      </div>
      <div>
        <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">{{ label }}</p>
        <p class="font-display text-3xl font-bold tabular-nums text-(--ui-text-highlighted)">{{ value }}</p>
      </div>
    </div>
    <p v-if="hint" class="mt-3 text-xs text-(--ui-text-muted)">{{ hint }}</p>
  </div>
</template>
