<!-- app/pages/player.vue -->
<!--
  /player route — loaded by the APK's WebView (Plan 5) or a desktop browser
  tab (Plan 3 QA). Fullscreen, layout-less, client-only, no UI chrome.

  Player composables are intentionally imported explicitly from
  `~/app/composables/player/*` rather than relying on Nuxt's recursive
  auto-import, to keep the dashboard's global import namespace clean.
-->
<script setup lang="ts">
import PlayerStage from '~/app/components/player/PlayerStage.vue'
import NoContentScreen from '~/app/components/player/NoContentScreen.vue'
import StandbyScreen from '~/app/components/player/StandbyScreen.vue'
import InterruptOverlay from '~/app/components/player/InterruptOverlay.vue'
import { usePlayerBoot } from '~/app/composables/player/usePlayerBoot'

definePageMeta({
  layout: false
})

const {
  screen, manifest, scheduler, env, deviceId, lastError,
  interruptPhase, interruptSrc, interruptSha, interruptOffsetNow,
  onStageStoodDown, onInterruptStarted, onInterruptFailed
} = usePlayerBoot()

useHead({
  title: 'Lanka Player',
  htmlAttrs: { class: 'lanka-player' }
})
</script>

<template>
  <div class="player-root">
    <StandbyScreen
      v-if="screen === 'booting' || screen === 'standby'"
      :device-id="deviceId"
      :last-error="lastError"
    />
    <NoContentScreen v-else-if="screen === 'no-content'" :device-id="deviceId" />
    <PlayerStage
      v-else-if="screen === 'playing' && manifest && scheduler"
      :key="manifest.playlistId + ':' + manifest.version"
      :manifest="manifest"
      :scheduler="scheduler"
      :env="env"
      :suspended="interruptPhase !== 'idle'"
      @stood-down="onStageStoodDown"
    />
    <!-- Sibling of the screen switch, not a child of the stage: the observance
         must also cover the standby and no-content screens, and no manifest
         change may remount it mid-window. -->
    <InterruptOverlay
      v-if="interruptPhase === 'playing' && interruptSrc && interruptSha"
      :sha256="interruptSha"
      :src="interruptSrc"
      :offset-now="interruptOffsetNow"
      @started="onInterruptStarted"
      @failed="onInterruptFailed"
    />
  </div>
</template>

<style>
html.lanka-player,
html.lanka-player body {
  margin: 0;
  padding: 0;
  background: #000;
  overflow: hidden;
  cursor: none;
  /* Override the dashboard's desktop min-width; the player fills whatever the
     WebView gives it. */
  min-width: 0 !important;
}
</style>

<style scoped>
.player-root {
  position: fixed;
  inset: 0;
  background: #000;
}
</style>
