<!-- app/components/ErrorFeed.vue -->
<script setup lang="ts">
// The device_errors API endpoint is planned but not yet built.
// Placeholder for now; wire to a list endpoint in a follow-up plan.
</script>

<template>
  <section class="soft-card overflow-hidden">
    <header class="border-b border-(--ui-border) px-4 py-3 sm:px-5">
      <h2 class="text-sm font-semibold">{{ $t('components.errorFeed.title') }}</h2>
    </header>
    <div class="p-4 sm:p-5">
      <EmptyState
        icon="i-lucide-clock-alert"
        :title="$t('components.errorFeed.pendingTitle')"
        :description="$t('components.errorFeed.pendingDescription')"
      />
    </div>
  </section>
</template>
