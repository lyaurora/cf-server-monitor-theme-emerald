<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useNodePingDisplay } from '@/composables/useNodePingDisplay'
import { useAppStore } from '@/stores/app'
import { resolvePingLines } from '@/utils/api'
import { getPingToneClass } from '@/utils/nodeHelper'

const props = defineProps<{ node: NodeData }>()
const appStore = useAppStore()
const pingLines = computed(() => resolvePingLines(Object.keys(props.node.ping ?? {}), appStore.publicSettings?.themeSettings.pingLinesByNode[props.node.uuid]))
const latencies = Array.from({ length: 3 }, (_, index) => useNodePingDisplay(() => props.node.uuid, { line: () => pingLines.value[index] ?? '' }).latestLatency)
const networks = computed(() => pingLines.value.map((key, index) => {
  const latency = latencies[index]!.value
  return {
    key,
    name: props.node.ping?.[key]?.name ?? key,
    latency: latency !== null ? `${Math.round(latency)}ms` : '--',
    toneClass: getPingToneClass(latency ?? 0, latency !== null),
  }
}))
</script>

<template>
  <div class="flex min-w-0 w-full items-center text-[10px]">
    <template v-if="networks.length">
      <template v-for="(net, index) in networks" :key="net.key">
        <span v-if="index" class="mx-1 text-muted-foreground" aria-hidden="true">·</span>
        <DataTooltip as="span" placement="cursor" :content="net.name" :class="net.toneClass" :aria-label="`${net.name} ${net.latency}`" content-class="whitespace-nowrap text-[11px] px-1.5">
          {{ net.latency }}
        </DataTooltip>
      </template>
    </template>
    <span v-else>N/A</span>
  </div>
</template>
