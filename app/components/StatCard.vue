<!-- app/components/StatCard.vue -->
<script setup lang="ts">
defineProps<{
  label: string
  value: number | string
  icon?: string
  hint?: string
  tone?: 'neutral' | 'emerald' | 'amber' | 'rose'
}>()
</script>

<template>
  <div
    class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-5"
  >
    <div class="flex items-center gap-3">
      <div
        v-if="icon"
        class="rounded-md p-2"
        :class="{
          'bg-zinc-500/10 text-zinc-400': !tone || tone === 'neutral',
          'bg-emerald-500/10 text-emerald-500': tone === 'emerald',
          'bg-amber-500/10 text-amber-500': tone === 'amber',
          'bg-rose-500/10 text-rose-500': tone === 'rose'
        }"
      >
        <UIcon :name="icon" class="size-5" />
      </div>
      <div>
        <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">
          {{ label }}
        </p>
        <p class="text-2xl font-semibold tabular-nums">{{ value }}</p>
      </div>
    </div>
    <p v-if="hint" class="mt-3 text-xs text-(--ui-text-muted)">{{ hint }}</p>
  </div>
</template>
