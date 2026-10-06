<script lang="ts" setup>
import type { ToasterProps } from 'vue-sonner'

import { Icon } from '@iconify/vue'
import { Toaster as Sonner } from 'vue-sonner'
import { cn } from '@/lib/utils'
import 'vue-sonner/style.css'

const props = defineProps<ToasterProps>()
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)" :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
    }" v-bind="props"
  >
    <template #success-icon>
      <Icon icon="lucide:circle-check" class="size-4" />
    </template>
    <template #info-icon>
      <Icon icon="lucide:info" class="size-4" />
    </template>
    <template #warning-icon>
      <Icon icon="lucide:triangle-alert" class="size-4" />
    </template>
    <template #error-icon>
      <Icon icon="lucide:octagon-x" class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Icon icon="lucide:loader-2" class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <Icon icon="lucide:x" class="size-4" />
    </template>
  </Sonner>
</template>

<style>
@reference '../../../styles/main.css';

.toaster[data-sonner-toaster] .connection-notice {
  @apply gap-3 rounded-md border-0 bg-background/50 pr-10 text-foreground shadow-[0_0_20px,0_0_0_1px] shadow-emerald-600/10 backdrop-blur-lg;
}

.toaster[data-sonner-toaster] .connection-notice [data-description] {
  @apply text-muted-foreground;
}

.toaster[data-sonner-toaster] .connection-notice [data-icon] {
  @apply text-amber-600 dark:text-amber-400;
}

.toaster[data-sonner-toaster] .connection-notice [data-button] {
  @apply h-8 rounded-md border border-border bg-transparent text-foreground transition-colors hover:bg-accent hover:text-accent-foreground;
}

.toaster[data-sonner-toaster] .connection-notice [data-close-button] {
  @apply top-2 right-2 left-auto size-6 rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground;
  transform: none;
}
</style>
