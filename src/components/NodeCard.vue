<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import NodePingRow from '@/components/NodePingRow.vue'
import { Badge } from '@/components/ui/badge'
import { CardX } from '@/components/ui/card-x'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { ProgressThin } from '@/components/ui/progress-thin'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getApiAssetUrl, resolvePingLines } from '@/utils/api'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, formatUptimeWithFormat, getStatus } from '@/utils/helper'
import { formatOfflineTime, getCustomTags, getRemainingTimeTagClass, getTrafficLevel, getTrafficUsed, getTrafficUsedPercentage, hasConfiguredPrice, hasRegion, showTrafficProgress } from '@/utils/nodeHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { formatPriceWithCycle, getDaysUntilExpired, getExpireStatus } from '@/utils/tagHelper'

const props = defineProps<{ node: NodeData }>()

const emit = defineEmits<{
  click: []
  pingClick: [node: NodeData]
}>()

const appStore = useAppStore()
const nodesStore = useNodesStore()
const { pickSurfaceClass } = useBackgroundSurface()

const formatBytes = (bytes: number) => formatBytesWithConfig(bytes, appStore.byteDecimals)
const formatBytesPerSecond = (bytes: number) => formatBytesPerSecondWithConfig(bytes, appStore.byteDecimals)
const formatUptime = (seconds: number) => formatUptimeWithFormat(seconds, 'hour')
const offlineTime = computed(() => formatOfflineTime(props.node))
const expiredDate = computed(() => formatDateTime(props.node.expired_at, 'YYYY-MM-DD'))

const cpuStatus = computed(() => getStatus(props.node.cpu ?? 0))
const memPercentage = computed(() => (props.node.ram ?? 0) / (props.node.mem_total || 1) * 100)
const memStatus = computed(() => getStatus(memPercentage.value))
const diskPercentage = computed(() => (props.node.disk ?? 0) / (props.node.disk_total || 1) * 100)
const diskStatus = computed(() => getStatus(diskPercentage.value))

const trafficUsedPercentage = computed(() => getTrafficUsedPercentage(props.node))
const trafficStatus = computed(() => getTrafficLevel(trafficUsedPercentage.value))
const trafficUsed = computed(() => getTrafficUsed(props.node))
const remainingTimeTagClass = computed(() => getRemainingTimeTagClass(props.node, nodesStore.pingNow.getTime()))
const customTags = computed(() => getCustomTags(props.node))

const pingLines = computed(() => resolvePingLines(Object.keys(props.node.ping ?? {}), appStore.publicSettings?.themeSettings.pingLinesByNode[props.node.uuid]))
const expiryText = computed(() => {
  if (!props.node.expired_at)
    return '--'
  const expiresAt = new Date(props.node.expired_at).getTime()
  if (!Number.isFinite(expiresAt))
    return '--'
  const now = nodesStore.pingNow.getTime()
  if (expiresAt <= now)
    return '已过期'
  const status = getExpireStatus(props.node.expired_at, now)
  if (status === 'long_term')
    return '长期'
  const days = getDaysUntilExpired(props.node.expired_at, now)
  return expiresAt - now < 86_400_000 ? '不足 1 天' : `剩余 ${days} 天`
})
const planText = computed(() => hasConfiguredPrice(props.node) ? formatPriceWithCycle(props.node.price, props.node.billing_cycle, props.node.currency, appStore.lang) : '--')

function openPingDialog() {
  emit('pingClick', props.node)
}
</script>

<template>
  <CardX
    hoverable
    class="node-card h-full w-full cursor-pointer border-none shadow-[0_0_0_1px] shadow-transparent transition-all duration-200 rounded-md bg-background/60 hover:bg-background hover:shadow-emerald-600/10 hover:shadow-[0_0_20px,0_0_0_1px] hover:-translate-y-0.5 hover:z-1"
    :class="[pickSurfaceClass('', 'backdrop-blur-sm'), !props.node.online && 'shadow-[0_0_0_1px] !shadow-red-600/20']"
    @click="emit('click')"
  >
    <template #header>
      <div class="flex gap-2 min-w-0 items-center">
        <div class="size-2 rounded-full relative" :class="[props.node.online ? 'bg-emerald-600' : 'bg-red-600']">
          <div
            class="animate-ping absolute inset-0 rounded-full opacity-50"
            :class="[props.node.online ? 'bg-emerald-600' : 'bg-red-600']"
          />
        </div>
        <RouterLink
          :to="{ name: 'instance-detail', params: { id: node.uuid }, query: node.source_index === undefined ? undefined : { apiIndex: node.source_index } }"
          class="text-md font-bold flex-1 min-w-0 truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="`${node.name}，${node.online ? '在线' : '离线'}，查看详情`" @click.stop
        >
          {{ props.node.name }}
        </RouterLink>
      </div>
    </template>

    <template #header-extra>
      <div class="flex gap-2 items-center">
        <img :src="getOSImage(props.node.os, props.node.source_index)" :alt="getOSName(props.node.os)" class="size-4">
        <img
          v-if="hasRegion(props.node.region)" :src="getApiAssetUrl(`flags/${getRegionCode(props.node.region).toLowerCase()}.svg`, props.node.source_index)"
          :alt="getRegionDisplayName(props.node.region)" class="size-5 shrink-0 rounded-sm drop-shadow-[0_0_2px_rgba(0,0,0,0.1)]"
        >
      </div>
    </template>

    <template #default>
      <div class="flex flex-col gap-3">
        <div class="gap-x-3 gap-y-1 grid grid-cols-2">
          <!-- CPU -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground">
                CPU
              </span>
              <span>{{ (props.node.cpu ?? 0).toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="props.node.cpu ?? 0" :status="cpuStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ props.node.load.toFixed(2) ?? 0 }}, {{ props.node.load5.toFixed(2) ?? 0 }}, {{
                props.node.load15.toFixed(2) ?? 0 }}
            </div>
          </div>

          <!-- 内存 -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground">
                内存
              </span>
              <span>{{ memPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="memPercentage" :status="memStatus" :height="4" />
            <DataTooltip placement="top" class="block" :content-class="[!props.node.swap && '!hidden']">
              <div class="text-[11px] text-muted-foreground truncate">
                {{ formatBytes(props.node.ram ?? 0) }} / {{ formatBytes(props.node.mem_total ?? 0) }}
              </div>
              <template #content>
                <div class="flex items-center justify-between gap-3 whitespace-nowrap">
                  <span class="text-background/70">Swap</span>
                  <span>{{ formatBytes(props.node.swap ?? 0) }}</span>
                </div>
              </template>
            </DataTooltip>
          </div>

          <!-- 硬盘 -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground">
                硬盘
              </span>
              <span>{{ diskPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="diskPercentage" :status="diskStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.disk ?? 0) }} / {{ formatBytes(props.node.disk_total ?? 0) }}
            </div>
          </div>

          <!-- 流量进度条 -->
          <div v-if="node.showTraffic !== false" class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground">
                流量
              </span>
              <span>{{ trafficUsedPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="trafficUsedPercentage" :status="trafficStatus" :height="4" />
            <DataTooltip placement="top" class="block">
              <div class="text-[11px] text-muted-foreground truncate">
                {{ formatBytes(trafficUsed) }} /
                <template v-if="showTrafficProgress(node)">
                  {{ formatBytes(props.node.traffic_limit) }}
                </template>
                <template v-else>
                  ∞
                </template>
              </div>
              <template #content>
                <div class="flex items-center justify-between gap-3 whitespace-nowrap">
                  <div class="text-[11px] flex flex-col">
                    <div class="flex flex-row items-center gap-1">
                      <Icon icon="tabler:chevron-up" width="12" height="12" />
                      {{ formatBytes(props.node.net_monthly_up ?? 0) }}
                    </div>
                    <div class="flex flex-row items-center gap-1">
                      <Icon icon="tabler:chevron-down" width="12" height="12" />
                      {{ formatBytes(props.node.net_monthly_down ?? 0) }}
                    </div>
                  </div>
                </div>
              </template>
            </DataTooltip>
          </div>
        </div>
        <div class="relative text-[11px] text-muted-foreground">
          <div
            v-if="!props.node.online"
            class="absolute inset-0 z-10 flex flex-col items-center justify-center space-y-1"
          >
            <span class="text-sm text-red-600">离线</span>
            <div>{{ offlineTime }}</div>
          </div>
          <div class="flex flex-col gap-y-2" :class="[!props.node.online && 'blur-xs opacity-60 pointer-events-none']">
            <!-- Glassmorphism 的三列双行结构，沿用 Emerald 的格式化与配色。 -->
            <div class="grid grid-cols-3 gap-2">
              <div class="flex min-w-0 flex-col gap-1">
                <div class="flex items-center gap-1 text-green-600">
                  <Icon icon="tabler:chevron-up" width="12" height="12" class="shrink-0" />
                  <span class="truncate">{{ formatBytesPerSecond(props.node.net_out ?? 0) }}</span>
                </div>
                <div class="flex items-center gap-1 text-blue-600">
                  <Icon icon="tabler:chevron-down" width="12" height="12" class="shrink-0" />
                  <span class="truncate">{{ formatBytesPerSecond(props.node.net_in ?? 0) }}</span>
                </div>
              </div>
              <div v-if="node.showTraffic !== false" class="flex min-w-0 flex-col gap-1">
                <div class="flex items-center gap-1">
                  <Icon icon="tabler:upload" width="12" height="12" class="shrink-0" />
                  <span class="truncate">{{ formatBytes(props.node.net_total_up ?? 0) }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <Icon icon="tabler:download" width="12" height="12" class="shrink-0" />
                  <span class="truncate">{{ formatBytes(props.node.net_total_down ?? 0) }}</span>
                </div>
              </div>
              <div v-if="node.showPrice !== false || node.showExpire !== false" class="flex min-w-0 flex-col gap-1">
                <DataTooltip v-if="node.showExpire !== false" placement="top" :content="expiredDate" class="min-w-0" content-class="whitespace-nowrap">
                  <div class="flex items-center gap-1" :class="remainingTimeTagClass">
                    <Icon icon="tabler:calendar-stats" width="12" height="12" class="shrink-0" />
                    <span class="truncate">{{ expiryText }}</span>
                  </div>
                </DataTooltip>
                <div v-if="node.showPrice !== false" class="flex items-center gap-1">
                  <Icon icon="tabler:coins" width="12" height="12" class="shrink-0" />
                  <span class="truncate">{{ planText }}</span>
                </div>
              </div>
            </div>
            <div class="flex items-center justify-between">
              <span class="truncate">
                在线
              </span>
              <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
              <span class="truncate">
                {{ props.node.uptime > 0 ? formatUptime(props.node.uptime) : '' }}
              </span>
            </div>
            <div v-if="nodesStore.showThreeNetDetails" class="flex flex-col gap-2">
              <!-- History reacts to its own store; CPU/traffic updates need not redraw these rows. -->
              <NodePingRow
                v-for="(line, index) in pingLines" :key="`${index}-${line}`"
                v-memo="[props.node.uuid, props.node.ping, pingLines.join(',')]"
                :node="props.node" :line-key="line" :index="index" :lines="pingLines"
                @ping-click="openPingDialog"
              />
              <span v-if="!pingLines.length">N/A</span>
            </div>
          </div>
        </div>
        <div v-if="customTags.length > 0" class="flex shrink-0 flex-wrap gap-1 items-center">
          <Badge
            v-for="(tag, index) in customTags" :key="index" variant="outline"
            class="!text-[11px] rounded text-muted-foreground border-muted-foreground/10 px-1.5"
          >
            {{ tag }}
          </Badge>
        </div>
      </div>
    </template>
  </CardX>
</template>

<style scoped>
.node-card {
  position: relative;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .animate-ping {
    animation: none;
  }
}
</style>
