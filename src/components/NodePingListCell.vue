<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useAppStore } from '@/stores/app'
import { resolvePingLines } from '@/utils/api'
import { getPingToneClass } from '@/utils/nodeHelper'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()
const pingLines = computed(() => resolvePingLines(Object.keys(props.node.ping ?? {}), appStore.publicSettings?.themeSettings.pingLinesByNode[props.node.uuid]))
const networks = computed(() => pingLines.value.map((key) => {
  const entry = props.node.ping?.[key]
  const timedOut = Boolean(entry && (entry.latest < 0 || entry.loss === 100))
  const validLatency = !timedOut && entry && Number.isFinite(entry.latest) && entry.latest >= 0 ? entry.latest : null
  return {
    key,
    name: entry?.name ?? key,
    latency: timedOut ? '超时' : validLatency !== null ? `${Math.round(validLatency)}ms` : '--',
    toneClass: timedOut ? 'text-rose-600 dark:text-rose-400' : getPingToneClass(validLatency ?? 0, validLatency !== null),
  }
}))
</script>

<template>
  <div class="flex min-w-0 w-full items-center text-[10px]">
    <template v-if="networks.length">
      <template v-for="(net, index) in networks" :key="net.key">
        <span v-if="index" class="mx-1 text-muted-foreground" aria-hidden="true">·</span>
        <DataTooltip as="span" placement="cursor" touch-behavior="passthrough" :content="net.name" :class="net.toneClass" :aria-label="`${net.name} ${net.latency}`" content-class="whitespace-nowrap text-[11px] px-1.5">
          {{ net.latency }}
        </DataTooltip>
      </template>
    </template>
    <span v-else>N/A</span>
  </div>
</template>
