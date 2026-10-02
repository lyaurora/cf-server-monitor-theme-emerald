<script setup lang="ts">
import type { PingRecord, PingSample } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import VChart from 'vue-echarts'
import { Button } from '@/components/ui/button'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { Empty } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { DEFAULT_CHART_TIME_RANGE, getAvailableChartTimeRanges } from '@/utils/chartTimeRange'
import { cutPeakValues } from '@/utils/recordHelper'
import { getSharedRpc } from '@/utils/rpc'
import '@/utils/echarts' // 共享 ECharts 配置

const props = defineProps<{
  uuid: string
}>()

const appStore = useAppStore()
const { pickSurfaceClass } = useBackgroundSurface()
const nodesStore = useNodesStore()
const nodeInfo = computed(() => nodesStore.nodesByUuid.get(props.uuid))
const isDark = computed(() => appStore.isDark)
// 使用共享的 RPC 实例，避免重复创建连接
const rpc = getSharedRpc()

// 图表主题相关颜色
const chartThemeColors = computed(() => ({
  text: isDark.value ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)',
  textSecondary: isDark.value ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.55)',
  textTertiary: isDark.value ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
  borderColor: isDark.value ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
  splitLineColor: isDark.value ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)',
  tooltipBg: isDark.value ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.8)',
  tooltipShadow: isDark.value ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.06)',
  crosshairColor: isDark.value ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
}))

// 优化后的图表配色方案（多任务时使用）
const chartColors = [
  '#FF6B6B', // 珊瑚红
  '#4ECDC4', // 青绿色
  '#A78BFA', // 紫罗兰
  '#60A5FA', // 天蓝色
  '#FFB347', // 琥珀黄
  '#F472B6', // 粉红色
  '#34D399', // 翠绿色
  '#FB923C', // 橙色
]

// 从 publicSettings 获取记录保留时间
const maxPingRecordPreserveTime = computed(() => appStore.publicSettings?.ping_record_preserve_time || 168)

// 可用视图列表
const availableViews = computed(() => getAvailableChartTimeRanges(maxPingRecordPreserveTime.value))

// 当前选中的视图
const selectedView = ref<string>(DEFAULT_CHART_TIME_RANGE.label)
const selectedHours = computed(() => {
  const view = availableViews.value.find(v => v.label === selectedView.value)
  return view?.hours ?? DEFAULT_CHART_TIME_RANGE.hours
})

// 初始化默认视图
watch(availableViews, (views) => {
  if (!views.some(view => view.label === selectedView.value))
    selectedView.value = views[0]?.label ?? DEFAULT_CHART_TIME_RANGE.label
}, { immediate: true })

// ==================== 类型定义 ====================

interface TaskInfo {
  id: number
  key?: string
  name: string
  interval?: number
  loss?: number
  p99?: number
  p50?: number
  p99_p50_ratio?: number
  min?: number
  max?: number
  avg?: number
  latest?: number
  total?: number
  type?: string
}

interface PingRecordsResponse {
  records: PingRecord[]
  tasks?: TaskInfo[]
}

interface PingChartData {
  records: PingRecord[]
  tasks: TaskInfo[]
}

// 数据状态
const remoteData = shallowRef<PingRecord[]>([])
const tasks = shallowRef<TaskInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let fetchRequestId = 0

// 任务选择
const selectedTaskIds = ref<number[]>([])
let selectAllTasks = true
const cutPeak = ref(false)
const showDelay = ref(true)
const showLoss = ref(true)
const chartMargin = { top: 30, right: 24, bottom: 52, left: 56 }

// ==================== 数据获取 ====================

async function fetchHistoryRecords(uuid: string, hours: number): Promise<PingChartData> {
  const result = await rpc.getClient().call<PingRecordsResponse>('common:getRecords', {
    type: 'ping',
    uuid,
    hours,
  })

  return {
    records: result?.records ?? [],
    tasks: result?.tasks ?? [],
  }
}

async function fetchRecords() {
  if (!props.uuid)
    return

  const requestId = ++fetchRequestId
  const uuid = props.uuid
  const hours = selectedHours.value
  const previousRecords = new Set(remoteData.value)

  loading.value = true
  error.value = null

  try {
    const result = await fetchHistoryRecords(uuid, hours)

    if (requestId !== fetchRequestId)
      return

    const liveRecords = selectedView.value === DEFAULT_CHART_TIME_RANGE.label
      ? remoteData.value.filter(record => !previousRecords.has(record))
      : []
    remoteData.value = mergePingRecords([...result.records, ...liveRecords])
    tasks.value = [...result.tasks, ...tasks.value.filter(task => liveRecords.some(record => record.task_id === task.id)
      && !result.tasks.some(item => item.id === task.id))]

    if (selectAllTasks) {
      selectedTaskIds.value = tasks.value.map(t => t.id)
    }
  }
  catch (err) {
    if (requestId !== fetchRequestId)
      return

    error.value = err instanceof Error ? err.message : '获取数据失败'
    remoteData.value = []
    tasks.value = []
  }
  finally {
    if (requestId === fetchRequestId) {
      loading.value = false
    }
  }
}

// ==================== 数据处理 ====================

function mergePingRecords(records: PingRecord[]): PingRecord[] {
  const merged = [...new Map(records.map(record => [`${record.task_id}:${record.time}`, record])).values()]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  const cutoff = Date.parse(merged.at(-1)?.time ?? '') - selectedHours.value * 3_600_000
  return merged.filter(record => Date.parse(record.time) >= cutoff)
}

const mergedData = computed(() => {
  const data = remoteData.value
  if (!data.length)
    return []

  const grouped: Map<number, Record<string, unknown>> = new Map()

  for (const rec of data) {
    const ts = dayjs(rec.time).valueOf()
    if (!Number.isFinite(ts))
      continue
    if (!grouped.has(ts))
      grouped.set(ts, { time: ts })

    const group = grouped.get(ts)!
    group[rec.task_id] = Number.isFinite(rec.value) && rec.value >= 0 ? rec.value : null
    group[`timeout_${rec.task_id}`] = rec.value < 0
  }

  const merged = Array.from(grouped.values()).sort(
    (a, b) => (a.time as number) - (b.time as number),
  )

  const hours = selectedHours.value
  const lastItem = merged.at(-1)
  const lastTs = lastItem ? lastItem.time as number : dayjs().valueOf()
  const fromTs = lastTs - hours * 3600_000

  let startIdx = 0
  for (let i = 0; i < merged.length; i++) {
    const item = merged[i]
    if (!item)
      continue
    const ts = item.time as number
    if (ts >= fromTs) {
      startIdx = Math.max(0, i - 1)
      break
    }
  }

  return merged.slice(startIdx)
})

const chartData = computed(() => {
  let data = mergedData.value
  const selectedKeys = selectedTaskIds.value.map(String)

  if (selectedKeys.length === 0)
    return []

  if (cutPeak.value) {
    const smoothed = cutPeakValues(data, selectedKeys)
    data = smoothed.map((row, index) => ({
      ...row,
      ...Object.fromEntries(selectedKeys.filter(key => data[index]?.[key] == null)
        .map(key => [key, null])),
    }))
  }

  return data
})

// ==================== 工具函数 ====================

function formatTime(time: number, showDate: boolean): string {
  const date = dayjs(time)
  if (showDate) {
    return date.format('M/D HH:mm')
  }
  return date.format('HH:mm')
}

function formatTimeForTooltip(time: number, hours: number): string {
  const date = dayjs(time)
  if (hours < 24) {
    return date.format('HH:mm:ss')
  }
  return date.format('MM/DD HH:mm')
}

const HTML_ESCAPE_REGEX = /[&<>"']/g
const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

function escapeHtml(value: string): string {
  return value.replace(HTML_ESCAPE_REGEX, character => HTML_ENTITIES[character]!)
}

const showDateInAxis = computed(() => selectedHours.value >= 24)

// ==================== 任务选择 ====================

// 获取任务颜色（根据任务在完整列表中的索引）
function getTaskColor(taskId: number): string {
  const taskIndex = tasks.value.findIndex(t => t.id === taskId)
  const safeIndex = Math.max(0, taskIndex % chartColors.length)
  return chartColors[safeIndex]!
}

function finiteMetric(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function average(values: number[]): number | undefined {
  if (!values.length)
    return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], ratio: number): number | undefined {
  if (!values.length)
    return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function sampleIntervalSeconds(records: PingRecord[]): number | undefined {
  const timestamps = [...new Set(records.map(record => dayjs(record.time).valueOf()))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (timestamps.length < 2)
    return undefined

  const deltas = timestamps.slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]!)
    .filter(delta => delta > 0)
    .sort((a, b) => a - b)
  if (!deltas.length)
    return undefined
  const seconds = Math.round(deltas[Math.floor(deltas.length / 2)]! / 1000)
  return seconds > 0 ? seconds : undefined
}

// 优先使用当前查询周期内的原始样本，缺少时才回退到接口聚合字段。
const latestValues = computed(() => {
  if (!tasks.value.length)
    return []

  return tasks.value.map((task, idx) => {
    const taskRecords = remoteData.value.filter(record => record.task_id === task.id)
    const latencyRecords = taskRecords.filter(record => record.value >= 0)
    const latencyValues = latencyRecords.map(record => record.value)
    const lossValues = taskRecords
      .map(record => finiteMetric(record.loss))
      .filter((value): value is number => value !== undefined)
    const latestRecord = taskRecords.at(-1)
    const latest = latestRecord && Number.isFinite(latestRecord.value) && latestRecord.value >= 0 ? latestRecord.value : undefined
    const p50 = percentile(latencyValues, 0.5)
    const p99 = percentile(latencyValues, 0.99)

    const safeIdx = Math.max(0, idx % chartColors.length)
    return {
      ...task,
      min: latencyValues.length ? Math.min(...latencyValues) : finiteMetric(task.min),
      max: latencyValues.length ? Math.max(...latencyValues) : finiteMetric(task.max),
      avg: average(latencyValues) ?? finiteMetric(task.avg),
      latest: latestRecord ? latest : finiteMetric(task.latest),
      timedOut: latestRecord !== undefined && latestRecord.value < 0,
      p50: p50 ?? finiteMetric(task.p50),
      p99: p99 ?? finiteMetric(task.p99),
      p99_p50_ratio: p50 && p99 ? p99 / p50 : finiteMetric(task.p99_p50_ratio),
      interval: sampleIntervalSeconds(latencyRecords) ?? finiteMetric(task.interval),
      loss: average(lossValues) ?? finiteMetric(task.loss),
      total: latencyRecords.length || finiteMetric(task.total),
      latestValue: latestRecord ? latest ?? null : finiteMetric(task.latest) ?? null,
      color: chartColors[safeIdx]!,
    }
  })
})

const selectedTasks = computed(() => {
  return tasks.value.filter(t => selectedTaskIds.value.includes(t.id))
})

const PING_TASK_KEYS: Record<number, string> = {
  1: 'ct',
  2: 'cu',
  3: 'cm',
  4: 'bd',
  5: 'node_1',
  6: 'node_2',
  7: 'node_3',
  8: 'node_4',
}

function appendRealtimePing(sample: PingSample): void {
  if (selectedView.value !== DEFAULT_CHART_TIME_RANGE.label || !sample.time)
    return

  const records = Object.entries(sample.ping).flatMap(([key, ping]) => {
    const taskId = Number(Object.keys(PING_TASK_KEYS).find(id => PING_TASK_KEYS[Number(id)] === key))
    if (!taskId || (!Number.isFinite(ping.latest) && !Number.isFinite(ping.loss)))
      return []

    if (!tasks.value.some(task => task.id === taskId)) {
      tasks.value = [...tasks.value, { id: taskId, key, name: ping.name }]
      if (selectAllTasks)
        selectedTaskIds.value = [...selectedTaskIds.value, taskId]
    }

    return [{
      client: props.uuid,
      task_id: taskId,
      time: sample.time,
      value: ping.loss === 100 ? -1 : ping.latest,
      loss: Number.isFinite(ping.loss) ? ping.loss : undefined,
    }]
  })

  if (!records.length)
    return

  remoteData.value = mergePingRecords([...remoteData.value, ...records])
}

const packetLossMarkers = computed(() => {
  const markers = new Map<number, number[]>()
  for (const task of selectedTasks.value) {
    const timestamps = remoteData.value
      .filter(record => record.task_id === task.id
        && ((record.loss ?? 0) > 0 || record.value < 0))
      .map(record => dayjs(record.time).valueOf())
      .filter(Number.isFinite)
    markers.set(task.id, [...new Set(timestamps)].sort((a, b) => a - b))
  }
  return markers
})

// 切换任务选中状态
function toggleTask(taskId: number) {
  if (selectedTaskIds.value.includes(taskId)) {
    selectedTaskIds.value = selectedTaskIds.value.filter(id => id !== taskId)
  }
  else {
    selectedTaskIds.value = [...selectedTaskIds.value, taskId]
  }
  selectAllTasks = tasks.value.every(task => selectedTaskIds.value.includes(task.id))
}

function showAllTasks() {
  selectAllTasks = true
  selectedTaskIds.value = tasks.value.map(t => t.id)
}

function hideAllTasks() {
  selectAllTasks = false
  selectedTaskIds.value = []
}

// ==================== 图表配置 ====================

// 通用 Tooltip 配置
const baseTooltipConfig = computed(() => ({
  trigger: 'axis' as const,
  confine: false,
  backgroundColor: chartThemeColors.value.tooltipBg,
  borderColor: 'transparent',
  borderWidth: 0,
  borderRadius: 6,
  textStyle: {
    color: chartThemeColors.value.text,
    fontSize: 12,
    lineHeight: 20,
  },
  extraCssText: `backdrop-filter: blur(5px);z-index:9;box-shadow:0 0 0 1px ${chartThemeColors.value.tooltipShadow}, 0 0 16px ${chartThemeColors.value.tooltipShadow}`,
  axisPointer: {
    type: 'cross' as const,
    crossStyle: {
      color: chartThemeColors.value.textTertiary,
    },
    lineStyle: {
      color: chartThemeColors.value.crosshairColor,
      width: 1,
      type: 'dashed' as const,
    },
    shadowStyle: {
      color: chartThemeColors.value.crosshairColor,
    },
  },
}))

const pingChartOption = computed(() => {
  const taskList = selectedTasks.value
  const data = chartData.value
  const hours = selectedHours.value
  const rowsByTime = new Map(data.map(row => [row.time as number, row]))
  const timestamps = remoteData.value
    .filter(record => selectedTaskIds.value.includes(record.task_id))
    .map(record => dayjs(record.time).valueOf())
    .filter(Number.isFinite)

  // 构建 series，确保颜色与卡片一致
  const series = taskList.map((task) => {
    const color = getTaskColor(task.id)
    const lossMarkerTimes = packetLossMarkers.value.get(task.id) || []
    return {
      id: String(task.id),
      name: task.name,
      type: 'line' as const,
      data: data.filter(d => Object.hasOwn(d, `timeout_${task.id}`))
        .map(d => [d.time as number, d[task.id] as number | null ?? null]),
      smooth: showDelay.value ? (cutPeak.value ? 0.6 : 0.1) : 0,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: showDelay.value ? 1.5 : 0, color, cap: 'round' as const },
      itemStyle: { color, opacity: showDelay.value ? 1 : 0 },
      markLine: showLoss.value && lossMarkerTimes.length
        ? {
            silent: true,
            symbol: ['none', 'none'],
            animation: false,
            label: { show: false },
            lineStyle: {
              color,
              width: 1,
              type: 'solid' as const,
              opacity: 0.55,
            },
            data: lossMarkerTimes.map(timestamp => ({
              xAxis: timestamp,
            })),
          }
        : undefined,
    }
  })

  // 颜色映射表（用于 Tooltip）
  const colorMap = new Map<number, string>()
  tasks.value.forEach((task, idx) => {
    const safeIdx = Math.max(0, idx % chartColors.length)
    colorMap.set(task.id, chartColors[safeIdx]!)
  })

  return {
    animation: false,
    // 全局颜色设置（用于图例等）
    color: tasks.value.map((_, idx) => {
      const safeIdx = Math.max(0, idx % chartColors.length)
      return chartColors[safeIdx]!
    }),
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ seriesId: string, value: [number, number | null] }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const rowData = rowsByTime.get(firstParam.value[0])
        if (!rowData)
          return ''

        const time = rowData.time as number
        const timeStr = formatTimeForTooltip(time, hours)
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'

        // 按延迟值排序显示，仅包含图例中可见的线路
        const visibleTaskIds = new Set(p.map(item => item.seriesId))
        const sortedParams = taskList.filter(task => visibleTaskIds.has(String(task.id))).map(task => ({
          taskId: task.id,
          seriesName: task.name,
          value: rowData[task.id] as number | null,
          timedOut: rowData[`timeout_${task.id}`] === true,
        })).sort((a, b) => (a.value ?? 0) - (b.value ?? 0))

        for (const item of sortedParams) {
          if (item.timedOut || (item.value !== null && item.value !== undefined)) {
            const color = colorMap.get(item.taskId) || chartColors[0]
            const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:8px;flex-shrink:0"></span>`
            const valueText = item.timedOut ? '超时' : `${Math.round(item.value!)} ms`
            html += `<div style="display:flex;align-items:center">${colorDot}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.seriesName)}</span><span style="margin-left:auto;font-weight:600;margin-left:16px;font-variant-numeric:tabular-nums">${valueText}</span></div>`
          }
        }
        html += '</div>'
        return html
      },
    },
    legend: {
      type: 'scroll',
      bottom: 0,
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 16,
      icon: 'roundRect',
      textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
      data: taskList.map(t => t.name),
    },
    grid: chartMargin,
    xAxis: {
      type: 'time',
      min: timestamps[0],
      max: timestamps.at(-1),
      axisLabel: {
        formatter: (value: number) => formatTime(value, showDateInAxis.value),
        fontSize: 11,
        color: chartThemeColors.value.textSecondary,
        margin: 12,
      },
      axisLine: {
        show: true,
        lineStyle: { color: chartThemeColors.value.borderColor, width: 1 },
      },
      axisTick: { show: false },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      name: '延迟 (ms)',
      nameTextStyle: { color: chartThemeColors.value.textSecondary },
      axisLabel: { fontSize: 11, color: chartThemeColors.value.textSecondary, formatter: '{value}' },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: {
        lineStyle: {
          color: chartThemeColors.value.splitLineColor,
          type: 'dashed' as const,
        },
      },
    },
    series,
  }
})

// ==================== 生命周期 ====================

watch(selectedView, () => {
  selectAllTasks = true
  selectedTaskIds.value = []
  fetchRecords()
})

watch(() => props.uuid, () => {
  selectAllTasks = true
  remoteData.value = []
  tasks.value = []
  selectedTaskIds.value = []
  fetchRecords()
})

watch(() => nodeInfo.value?.pingSample, (sample) => {
  if (sample)
    appendRealtimePing(sample)
}, { flush: 'sync' })

onMounted(() => {
  fetchRecords()
})

onBeforeUnmount(() => fetchRequestId++)
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 时间选择器 -->
    <Tabs v-model="selectedView" class="w-full items-center">
      <div class="min-w-0 flex-1 overflow-x-auto pointer-events-auto">
        <TabsList :class="pickSurfaceClass('w-max h-8 bg-background/60 rounded-md', 'w-max h-8 bg-background/50 backdrop-blur-xl rounded-md')">
          <TabsTrigger
            v-for="view in availableViews" :key="view.label" :value="view.label"
            class="h-6.5 flex-none shrink-0 text-xs border-none data-[state=active]:text-emerald-600 shadow-none rounded-sm"
          >
            {{ view.label }}
          </TabsTrigger>
        </TabsList>
      </div>
      <div class="md:flex-1" />
      <div class="flex gap-2 items-center">
        <Button
          variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
          :class="[selectedTaskIds.length === tasks.length && 'bg-background !text-emerald-600']"
          @click="showAllTasks"
        >
          全选
        </Button>
        <Button
          variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
          :class="[!selectedTaskIds.length && 'bg-background !text-emerald-600']"
          @click="hideAllTasks"
        >
          全不选
        </Button>
      </div>
    </Tabs>

    <!-- 内容区域 -->
    <Spinner :show="loading" content-class="flex flex-col gap-4">
      <div v-if="error" class="text-red-500 py-8 text-center">
        {{ error }}
      </div>
      <div v-else-if="tasks.length === 0 && !loading" class="py-8">
        <Empty description="暂无延迟数据" />
      </div>

      <template v-else>
        <!-- 最新值统计卡片（可点击切换选中状态） -->
        <div
          v-if="latestValues.length > 0" class="gap-3 grid"
          style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))"
        >
          <div
            v-for="task in latestValues" :key="task.id"
            role="button" tabindex="0" :aria-pressed="selectedTaskIds.includes(task.id)"
            class="flex cursor-pointer select-none items-center gap-3 rounded-md p-2 transition-all bg-background/60 hover:bg-background hover:shadow-[0_0_0_1px] hover:shadow-emerald-600/10"
            :class="[
              !selectedTaskIds.includes(task.id) && 'opacity-30',
            ]"
            :onmouseover="(e: MouseEvent) => ((e.currentTarget as HTMLElement).style.borderColor = task.color)"
            :onmouseout="(e: MouseEvent) => ((e.currentTarget as HTMLElement).style.borderColor = '')"
            @click="toggleTask(task.id)"
            @keydown.enter.self.prevent="toggleTask(task.id)"
            @keydown.space.self.prevent="toggleTask(task.id)"
          >
            <div class="flex-1 min-w-0">
              <div class="flex gap-2 items-center">
                <div class="rounded h-4 w-1" :style="{ backgroundColor: task.color }" />
                <span class="text-sm font-semibold truncate">{{ task.name }}</span>
                <div class="flex-1" />
                <DataTooltip placement="left" content-class="!rounded p-3 w-60 backdrop-blur">
                  <Button variant="ghost" size="icon-xs" class="text-slate-500" :aria-label="`${task.name}线路统计`" @click.stop>
                    <Icon icon="carbon:information" :width="14" :height="14" />
                  </Button>
                  <template #content>
                    <div class="text-xs gap-x-4 gap-y-1.5 grid grid-cols-4">
                      <template v-if="task.min !== undefined">
                        <span class="text-muted-foreground">最小</span>
                        <span class="font-medium">{{ Math.round(task.min) }} ms</span>
                      </template>
                      <template v-if="task.max !== undefined">
                        <span class="text-muted-foreground">最大</span>
                        <span class="font-medium">{{ Math.round(task.max) }} ms</span>
                      </template>
                      <template v-if="task.avg !== undefined">
                        <span class="text-muted-foreground">平均</span>
                        <span class="font-medium">{{ Math.round(task.avg) }} ms</span>
                      </template>
                      <template v-if="task.latest !== undefined || task.timedOut">
                        <span class="text-muted-foreground">最新</span>
                        <span class="font-medium">{{ task.timedOut ? '超时' : `${Math.round(task.latest!)} ms` }}</span>
                      </template>
                      <template v-if="task.p50 !== undefined">
                        <span class="text-muted-foreground">P50</span>
                        <span class="font-medium">{{ Math.round(task.p50) }} ms</span>
                      </template>
                      <template v-if="task.p99 !== undefined">
                        <span class="text-muted-foreground">P99</span>
                        <span class="font-medium">{{ Math.round(task.p99) }} ms</span>
                      </template>
                      <template v-if="task.p99_p50_ratio !== undefined">
                        <span class="text-muted-foreground">波动率</span>
                        <span class="font-medium">{{ task.p99_p50_ratio.toFixed(2) }}</span>
                      </template>
                      <template v-if="task.interval !== undefined">
                        <span class="text-muted-foreground">间隔</span>
                        <span class="font-medium">{{ task.interval }}s</span>
                      </template>
                      <template v-if="task.type">
                        <span class="text-muted-foreground">类型</span>
                        <span class="font-medium">{{ task.type.toUpperCase() }}</span>
                      </template>
                      <template v-if="task.total !== undefined">
                        <span class="text-muted-foreground">总数</span>
                        <span class="font-medium">{{ task.total }}</span>
                      </template>
                    </div>
                  </template>
                </DataTooltip>
              </div>
              <div class="text-xs mt-1 flex gap-1.5 items-center text-muted-foreground">
                <span v-if="task.timedOut" class="text-rose-500" title="最新探测">超时 ·</span>
                <span class="font-medium" title="平均延迟">
                  {{ task.avg !== undefined ? `${Math.round(task.avg)}ms` : '-' }}
                </span>
                <template v-if="task.loss !== undefined">
                  <span class="opacity-60">·</span>
                  <span title="丢包率">{{ task.loss.toFixed(2) }}%</span>
                </template>
                <template v-if="task.p99_p50_ratio !== undefined">
                  <span class="opacity-60">·</span>
                  <span title="波动率">{{ task.p99_p50_ratio.toFixed(2) }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2 items-center py-2">
          <!-- 延迟可视化开关 -->
          <Button
            variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
            :aria-pressed="showDelay"
            :class="[showDelay && 'bg-background !text-emerald-600']" @click="showDelay = !showDelay"
          >
            延迟
          </Button>
          <!-- 丢包可视化开关 -->
          <Button
            variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
            :aria-pressed="showLoss"
            :class="[showLoss && 'bg-background !text-emerald-600']" @click="showLoss = !showLoss"
          >
            丢包
          </Button>
          <!-- 平滑峰值开关 -->
          <div class="flex gap-2 items-center">
            <Button
              variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
              :aria-pressed="cutPeak"
              :class="[cutPeak && 'bg-background !text-emerald-600']" @click="cutPeak = !cutPeak"
            >
              平滑峰值
            </Button>
            <DataTooltip
              content="使用 EWMA 算法平滑数据并过滤突变值"
              placement="top"
              :content-class="pickSurfaceClass('whitespace-nowrap text-[11px]', 'whitespace-nowrap text-[11px] backdrop-blur-xl')"
            >
              <Button variant="ghost" size="icon-xs" class="text-slate-500" aria-label="平滑峰值说明">
                <Icon icon="carbon:information" :width="14" :height="14" />
              </Button>
            </DataTooltip>
          </div>
        </div>

        <!-- 图表 -->
        <div
          class="h-80 rounded-md p-4 transition-all"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xl')"
        >
          <VChart :option="pingChartOption" :update-options="{ replaceMerge: ['series'] }" autoresize />
        </div>
      </template>
    </Spinner>
  </div>
</template>
