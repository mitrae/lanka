<!-- app/components/ErrorFeed.vue -->
<script setup lang="ts">
// The device_errors API endpoint is planned but not yet built.
// Placeholder for now; wire to a list endpoint in a follow-up plan.
</script>

<template>
  <section class="soft-card overflow-hidden">
    <header class="border-b border-(--ui-border) px-5 py-3">
      <h2 class="text-sm font-semibold">Recent playback errors</h2>
    </header>
    <div class="p-5">
      <EmptyState
        icon="i-lucide-clock-alert"
        title="Error feed pending"
        description="The /api/device-errors endpoint hasn't been added yet. Coming in a follow-up plan."
      />
    </div>
  </section>
</template>
