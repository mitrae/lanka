<!-- app/components/VisibilityBadge.vue -->
<script setup lang="ts">
// Occlusion is deliberately NOT a status tier: a covered device is perfectly
// online, and collapsing the two facts into one pill would destroy information.
// Rendered only while the device is online — otherwise a box that died
// mid-occlusion would advertise "covered" forever, which is worse than silence.
const props = defineProps<{
  visibility: 'foreground' | 'obscured' | 'background' | 'unknown'
  foregroundPackage?: string | null
  online: boolean
}>()

const { t } = useI18n()

const show = computed(
  () => props.online && (props.visibility === 'obscured' || props.visibility === 'background')
)

const label = computed(() => {
  // A dialog needs a different operator response from an app switch: usually a
  // system prompt to dismiss or an OTA to finish, not a kiosk-lock problem.
  if (props.visibility === 'obscured') return t('devices.dialogOnTop')
  if (props.foregroundPackage) return t('devices.coveredBy', { app: props.foregroundPackage })
  return t('devices.notOnScreen')
})
</script>

<template>
  <UBadge v-if="show" color="warning" variant="subtle" size="sm" icon="i-lucide-eye-off">
    {{ label }}
  </UBadge>
</template>
