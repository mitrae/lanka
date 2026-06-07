<script setup lang="ts">
const props = withDefaults(defineProps<{
  value: number
  total: number
  size?: number
  label?: string
  color?: string
}>(), { size: 132, color: '#6366f1' })

const radius = computed(() => props.size / 2 - 10)
const circumference = computed(() => 2 * Math.PI * radius.value)
const pct = computed(() => (props.total > 0 ? Math.min(1, props.value / props.total) : 0))
const dash = computed(() => `${circumference.value * pct.value} ${circumference.value}`)
</script>

<template>
  <div class="flex flex-col items-center">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke="var(--donut-track)" stroke-width="12" />
      <circle
        :cx="size / 2" :cy="size / 2" :r="radius" fill="none"
        :stroke="color" stroke-width="12" stroke-linecap="round"
        :stroke-dasharray="dash"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        style="transition: stroke-dasharray 600ms ease"
      />
      <text
        :x="size / 2" :y="size / 2 - 2" text-anchor="middle"
        class="fill-current font-display text-(--ui-text-highlighted)"
        font-size="26" font-weight="700"
      >{{ value }}</text>
      <text
        :x="size / 2" :y="size / 2 + 18" text-anchor="middle"
        class="fill-current text-(--ui-text-dimmed)"
        font-size="11"
      >/ {{ total }}</text>
    </svg>
    <span v-if="label" class="mt-2 text-xs text-(--ui-text-muted)">{{ label }}</span>
  </div>
</template>
