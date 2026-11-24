<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import NodePingListCell from '@/components/NodePingListCell.vue'
import { Badge } from '@/components/ui/badge'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { ProgressThin } from '@/components/ui/progress-thin'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getApiAssetUrl } from '@/utils/api'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatUptimeWithFormat, getStatus } from '@/utils/helper'
import { formatOfflineTime, getCustomTags, getPriceTags, getRemainingTimeTagClass, getTrafficLevel, getTrafficUsed, getTrafficUsedPercentage, hasRegion, showTrafficProgress } from '@/utils/nodeHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'

interface ColumnConfig {
  key: string
  label: string
  width: string | number
  sortable: boolean
}

const props = defineProps<{
  node: NodeData
  visibleColumns: ColumnConfig[]
  gridStyle: CSSProperties
  offlineOverlayColumnStart: number
}>()

const emit = defineEmits<{
  click: [node: NodeData]
  pingClick: [node: NodeData]
}>()

const appStore = useAppStore()
const nodesStore = useNodesStore()
const { pickSurfaceClass } = useBackgroundSurface()

const formatBytes = (bytes: number) => formatBytesWithConfig(bytes, appStore.byteDecimals)
const formatBytesPerSecond = (bytes: number) => formatBytesPerSecondWithConfig(bytes, appStore.byteDecimals)
const formatUptime = (seconds: number) => formatUptimeWithFormat(seconds, 'hour')

const flagSrc = computed(() => getApiAssetUrl(`flags/${getRegionCode(props.node.region).toLowerCase()}.svg`))
const memPercentage = computed(() => (props.node.ram ?? 0) / (props.node.mem_total || 1) * 100)
const diskPercentage = computed(() => (props.node.disk ?? 0) / (props.node.disk_total || 1) * 100)
const trafficUsed = computed(() => getTrafficUsed(props.node))
const trafficUsedPercentage = computed(() => getTrafficUsedPercentage(props.node))
const customTags = computed(() => getCustomTags(props.node))
const priceTags = computed(() => getPriceTags(props.node, appStore.lang, nodesStore.pingNow.getTime()))
const remainingTimeTagClass = computed(() => getRemainingTimeTagClass(props.node, nodesStore.pingNow.getTime()))
const offlineTime = computed(() => formatOfflineTime(props.node))
</script>

<template>
  <div
    class="relative flex h-16 cursor-pointer flex-col justify-center rounded-lg px-2 shadow-[0_0_4px,0_0_0_1px] shadow-transparent transition-all bg-background/60 hover:bg-background hover:shadow-emerald-600/10"
    :class="[pickSurfaceClass('', 'backdrop-blur-sm'), !node.online && '!shadow-red-600/10']"
    @click="emit('click', node)"
  >
    <div class="grid gap-2 items-center" :style="gridStyle" :aria-hidden="node.online ? undefined : 'true'" :inert="!node.online || undefined">
      <template v-for="col in visibleColumns" :key="col.key">
        <!-- 在线状态指示器 -->
        <div v-if="col.key === 'status'" class="flex justify-center">
          <div class="size-2 rounded-full relative" :class="[node.online ? 'bg-emerald-600' : 'bg-red-600']">
            <div
              class="animate-ping absolute inset-0 rounded-full opacity-50"
              :class="[node.online ? 'bg-emerald-600' : 'bg-red-600']"
            />
          </div>
        </div>

        <!-- 操作系统 -->
        <div v-else-if="col.key === 'os'" class="flex justify-center" :class="[!node.online && 'blur-sm opacity-30']">
          <img :src="getOSImage(node.os)" :alt="getOSName(node.os)" class="size-4">
        </div>

        <!-- 节点名称 -->
        <div v-else-if="col.key === 'name'" class="space-y-0.5" :class="[!node.online && 'blur-sm opacity-30']">
          <div class="flex gap-1 items-center text-xs font-semibold">
            <img
              v-if="hasRegion(node.region)" :src="flagSrc"
              :alt="getRegionDisplayName(node.region)" class="size-5 rounded-sm drop-shadow-[0_0_2px_rgba(0,0,0,0.1)]"
            >
            <RouterLink
              v-if="node.online"
              :to="{ name: 'instance-detail', params: { id: node.uuid } }"
              class="truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :aria-label="`${node.name}，在线，查看详情`" @click.stop
            >
              {{ node.name }}
            </RouterLink>
            <span v-else class="truncate">{{ node.name }}</span>
          </div>
          <div v-if="node.uptime || priceTags.length" class="text-[11px] text-muted-foreground/70 truncate">
            <span v-if="node.uptime">{{ formatUptime(node.uptime) }}</span>
            <span v-for="(tag, tagIndex) in priceTags" :key="tagIndex" :class="(node.uptime > 0 || tagIndex > 0) && 'ml-1'">
              <template v-if="tag.highlightValue">
                <span :class="remainingTimeTagClass">{{ tag.highlightValue }}</span>
              </template>
              <template v-else>
                {{ tag.text }}
              </template>
            </span>
          </div>
        </div>

        <!-- 标签 -->
        <div v-else-if="col.key === 'tags'" :class="[!node.online && 'blur-sm opacity-30']">
          <div class="flex flex-wrap gap-1 items-center">
            <Badge
              v-for="(tag, tagIndex) in customTags" :key="tagIndex" variant="outline"
              class="!text-[11px] rounded text-muted-foreground border-muted-foreground/10 px-1.5"
            >
              {{ tag }}
            </Badge>
          </div>
        </div>

        <!-- 与卡片选线一致的最新延迟 -->
        <div v-else-if="col.key === 'latency'" class="flex items-center" :class="[!node.online && 'blur-sm opacity-30']">
          <NodePingListCell
            :node="node"
            role="button"
            tabindex="0"
            class="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="`${node.name} 延迟`"
            @click.stop="emit('pingClick', node)"
            @keydown.enter.stop.prevent="emit('pingClick', node)"
            @keydown.space.stop.prevent="emit('pingClick', node)"
          />
        </div>

        <!-- CPU -->
        <div v-else-if="col.key === 'cpu'" class="group" :class="[!node.online && 'blur-sm opacity-30']">
          <div class="space-y-1">
            <div class="text-[10px] text-muted-foreground truncate">
              <span class="inline group-hover:hidden">
                {{ (node.cpu ?? 0).toFixed(1) }}%
              </span>
              <span class="hidden group-hover:inline">
                {{ (node.load ?? 0).toFixed(2) }}, {{ (node.load5 ?? 0).toFixed(2) }}, {{ (node.load15 ?? 0).toFixed(2) }}
              </span>
            </div>
            <ProgressThin :percentage="node.cpu ?? 0" :status="getStatus(node.cpu ?? 0)" :height="4" />
          </div>
        </div>

        <!-- 内存 -->
        <div v-else-if="col.key === 'mem'" class="group" :class="[!node.online && 'blur-sm opacity-30']">
          <DataTooltip placement="top" class="block" :disabled="!node.swap">
            <div class="space-y-1">
              <div class="text-[10px] text-muted-foreground truncate">
                <span class="inline group-hover:hidden">
                  {{ memPercentage.toFixed(1) }}%
                </span>
                <span class="hidden group-hover:inline">
                  {{ formatBytes(node.ram ?? 0) }} / {{ formatBytes(node.mem_total ?? 0) }}
                </span>
              </div>
              <ProgressThin
                :percentage="memPercentage"
                :status="getStatus(memPercentage)" :height="4"
              />
            </div>
            <template #content>
              <div class="flex items-center justify-between gap-3 whitespace-nowrap">
                <span class="text-background/70">Swap</span>
                <span>{{ formatBytes(node.swap ?? 0) }}</span>
              </div>
            </template>
          </DataTooltip>
        </div>

        <!-- 硬盘 -->
        <div v-else-if="col.key === 'disk'" class="group" :class="[!node.online && 'blur-sm opacity-30']">
          <div class="space-y-1">
            <div class="text-[10px] text-muted-foreground truncate">
              <span class="inline group-hover:hidden">
                {{ diskPercentage.toFixed(1) }}%
              </span>
              <span class="hidden group-hover:inline">
                {{ formatBytes(node.disk ?? 0) }} / {{ formatBytes(node.disk_total ?? 0) }}
              </span>
            </div>
            <ProgressThin
              :percentage="diskPercentage"
              :status="getStatus(diskPercentage)" :height="4"
            />
          </div>
        </div>

        <!-- 流量 -->
        <div v-else-if="col.key === 'traffic'" class="group" :class="[!node.online && 'blur-sm opacity-30']">
          <DataTooltip v-if="node.showTraffic !== false" placement="top" class="flex items-center gap-2" content-class="mb-1.5">
            <div class="space-y-1 w-full">
              <div class="text-[10px] text-muted-foreground truncate">
                <span class="inline group-hover:hidden">
                  {{ trafficUsedPercentage.toFixed(1) }}%
                </span>
                <span class="hidden group-hover:inline">
                  {{ formatBytes(trafficUsed) }} /
                  <template v-if="showTrafficProgress(node)">{{ formatBytes(node.traffic_limit) }}</template>
                  <template v-else>∞</template>
                </span>
              </div>
              <ProgressThin
                :percentage="trafficUsedPercentage"
                :status="getTrafficLevel(trafficUsedPercentage)" :height="4"
              />
            </div>
            <template #content>
              <span class="flex flex-row gap-0.5 items-center whitespace-nowrap">
                <Icon icon="tabler:chevron-up" width="12" height="12" />
                {{ formatBytes(node.net_monthly_up ?? 0) }}
              </span>
              <span class="flex flex-row gap-0.5 items-center whitespace-nowrap">
                <Icon icon="tabler:chevron-down" width="12" height="12" />
                {{ formatBytes(node.net_monthly_down ?? 0) }}
              </span>
            </template>
          </DataTooltip>
        </div>

        <!-- 速率 -->
        <div v-else-if="col.key === 'rate'" :class="[!node.online && 'blur-sm opacity-30']">
          <div class="text-[10px] flex flex-col">
            <span class="text-emerald-600 flex flex-row gap-1 items-center">
              <Icon icon="tabler:chevron-up" width="12" height="12" />
              {{ formatBytesPerSecond(node.net_out ?? 0) }}
            </span>
            <span class="text-blue-600 flex flex-row gap-1 items-center">
              <Icon icon="tabler:chevron-down" width="12" height="12" />
              {{ formatBytesPerSecond(node.net_in ?? 0) }}
            </span>
          </div>
        </div>
      </template>
    </div>

    <div
      v-if="!node.online" class="absolute inset-0 z-2 p-2 bg-background/10 rounded-lg flex items-center"
    >
      <div class="grid w-full gap-2 items-center" :style="gridStyle">
        <div class="h-full space-y-1" :style="{ gridColumn: `${offlineOverlayColumnStart} / -1` }">
          <RouterLink
            :to="{ name: 'instance-detail', params: { id: node.uuid } }"
            class="block truncate rounded-sm text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="`${node.name}，离线，查看详情`" @click.stop
          >
            <span class="text-red-500">离线</span> {{ node.name }}
          </RouterLink>
          <div class="text-xs text-muted-foreground">
            {{ offlineTime }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .animate-ping {
    animation: none;
  }
}
</style>
