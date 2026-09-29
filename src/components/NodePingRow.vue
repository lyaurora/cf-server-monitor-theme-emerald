<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useNodePingDisplay } from '@/composables/useNodePingDisplay'
import { useAppStore } from '@/stores/app'
import { message } from '@/utils/message'

const props = defineProps<{ node: NodeData, lineKey: string, index: number, lines: string[] }>()
const emit = defineEmits<{ pingClick: [] }>()
const appStore = useAppStore()
const name = computed(() => props.node.ping?.[props.lineKey]?.name ?? props.lineKey)
const { latencyDisplay, lossDisplay, latencyPanelTooltip, lossPanelTooltip, latencyRenderBars, lossRenderBars } = useNodePingDisplay(() => props.node.uuid, { line: () => props.lineKey })
const panels = computed(() => [
  { name: '延迟', bars: latencyRenderBars.value },
  { name: '丢包', bars: lossRenderBars.value },
])

async function selectLine(key: string) {
  try {
    await appStore.updateNodePingLines(props.node.uuid, props.index, key, Object.keys(props.node.ping ?? {}))
  }
  catch (error) {
    message.error(error instanceof Error ? error.message : '线路保存失败，请重试')
  }
}
</script>

<template>
  <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" @click.stop @keydown.stop>
    <div class="flex min-w-0 items-center justify-between gap-1">
      <DropdownMenuRoot v-if="appStore.isLoggedIn">
        <DropdownMenuTrigger as-child>
          <button
            type="button" class="min-w-0 truncate rounded text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :disabled="appStore.savingPingLines.has(`${node.uuid}:${index}`)" :aria-label="`切换${name}线路`"
          >
            {{ name }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="start" :side-offset="4"
            class="z-50 max-h-64 min-w-32 overflow-y-auto rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
            @click.stop @keydown.stop
          >
            <DropdownMenuItem
              v-for="(entry, key) in node.ping" :key="key"
              class="flex cursor-pointer items-center justify-between gap-4 rounded px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              :class="{ 'bg-accent': key === lineKey }"
              :disabled="key === lineKey" @select="selectLine(String(key))"
            >
              <span>{{ entry.name }}</span>
              <Icon v-if="key === lineKey" icon="tabler:check" class="size-3.5 text-emerald-600" aria-hidden="true" />
              <span v-else-if="lines.includes(String(key))" class="text-muted-foreground">互换</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      <span v-else class="truncate">{{ name }}</span>
      <DataTooltip as="button" type="button" placement="cursor" class="shrink-0 rounded font-medium text-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :content="latencyPanelTooltip" :aria-label="`${name} 延迟 ${latencyDisplay}`" @click="emit('pingClick')">
        {{ latencyDisplay }}
      </DataTooltip>
    </div>
    <DataTooltip as="button" type="button" placement="cursor" class="rounded text-right font-medium text-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :content="lossPanelTooltip" :aria-label="`${name} 丢包 ${lossDisplay}`" @click="emit('pingClick')">
      {{ lossDisplay }}
    </DataTooltip>
    <button
      v-for="panel in panels" :key="panel.name" type="button"
      class="grid h-2 items-center gap-px rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :style="{ gridTemplateColumns: `repeat(${panel.bars.length}, minmax(0, 1fr))` }"
      :aria-label="`${name} ${panel.name}历史，查看图表`" @click.capture.stop="emit('pingClick')"
    >
      <DataTooltip
        v-for="bar in panel.bars" :key="bar.key" as="span" placement="cursor"
        :content="bar.tooltip" class="h-[5px] w-full"
        content-class="whitespace-nowrap w-max px-1.5 !leading-[1.2] text-[11px]"
      >
        <span class="block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-200" :class="bar.className" />
      </DataTooltip>
    </button>
  </div>
</template>
