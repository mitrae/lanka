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
  <div class="soft-card p-5">
    <div class="flex items-center gap-3">
      <div
        v-if="icon"
        class="rounded-xl p-2.5"
        :class="{
          'bg-black/5 text-black/70': !tone || tone === 'neutral',
          'bg-emerald-500/10 text-emerald-600': tone === 'emerald',
          'bg-amber-500/10 text-amber-600': tone === 'amber',
          'bg-rose-500/10 text-rose-500': tone === 'rose',
          'bg-blue-500/10 text-blue-600': tone === 'blue'
        }"
      >
        <UIcon :name="icon" class="size-5" />
      </div>
      <div>
        <p class="text-xs uppercase tracking-wide text-(--ui-text-muted)">{{ label }}</p>
        <p class="font-display text-3xl font-bold tabular-nums">{{ value }}</p>
      </div>
    </div>
    <p v-if="hint" class="mt-3 text-xs text-(--ui-text-muted)">{{ hint }}</p>
  </div>
</template>
