<script setup lang="ts">
import { useDark } from '@vueuse/core'
import { computed, provide, ref, watch } from 'vue'
import { BackTop } from '@/components/ui/back-top'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

const isScrolled = ref(false)
provide('isScrolled', isScrolled)

useDark({
  storageRef: computed(() => appStore.isDark ? 'dark' : 'light'),
  onChanged: (dark, defaultHandler) => {
    defaultHandler(dark ? 'dark' : 'light')
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  },
})

watch(
  () => appStore.backgroundEnabled,
  (enabled) => {
    const body = document.body
    if (enabled)
      body.style.setProperty('background-color', 'transparent', 'important')
    else
      body.style.removeProperty('background-color')
  },
  { immediate: true },
)
</script>

<template>
  <slot />
  <BackTop :visibility-height="1" @scrolled="isScrolled = $event" />
</template>
