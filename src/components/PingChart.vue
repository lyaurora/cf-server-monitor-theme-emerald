<script setup lang="ts">
import type { PingRecord, PingSample } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import dayjs from 'dayjs'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { Empty } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { formatChartTooltipTime, renderTooltipRow, useChartTheme } from '@/composables/useChartTheme'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { fetchPingHistory } from '@/utils/api'
import { DEFAULT_CHART_TIME_RANGE, getAvailableChartTimeRanges } from '@/utils/chartTimeRange'
import { cutPeakValues } from '@/utils/recordHelper'

const props = defineProps<{
  uuid: string
}>()

const VChart = defineAsyncComponent(() => import('@/utils/echarts'))

const appStore = useAppStore()
const { pickSurfaceClass } = useBackgroundSurface()
const nodesStore = useNodesStore()
const nodeInfo = computed(() => nodesStore.nodesByUuid.get(props.uuid))
const { chartThemeColors, baseTooltipConfig } = useChartTheme({
  alwaysBlurTooltip: true,
  lightBorderColor: 'rgba(0, 0, 0, 0.06)',
})

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

// 从 publicSettings 获取记录保留时间（未加载完成前按匿名上限 24 小时兜底）
const maxPingRecordPreserveTime = computed(() => appStore.publicSettings?.ping_record_preserve_time || 24)

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
}

interface TimedPingRecord extends PingRecord {
  timeMs: number
}

// 数据状态
const remoteData = shallowRef<TimedPingRecord[]>([])
const tasks = shallowRef<TaskInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let fetchRequestId = 0

// 任务选择
// 保留当前时间范围内暂时无数据的线路选择。
const selectedTaskIds = ref<number[]>([])
const selectedTasks = computed(() => tasks.value.filter(task => selectedTaskIds.value.includes(task.id)))
// 仅默认状态和显式“全选”自动选择新出现的线路。
let selectAllTasks = true
const cutPeak = ref(false)
const showDelay = ref(true)
const showLoss = ref(true)
const chartMargin = {
  top: 30,
  right: 24,
  bottom: 52,
  left: 56,
}

// ==================== 数据获取 ====================

async function fetchRecords() {
  if (!props.uuid)
    return

  const requestId = ++fetchRequestId
  const uuid = props.uuid
  const hours = selectedHours.value
  const realtime = selectedView.value === DEFAULT_CHART_TIME_RANGE.label
  const previousRecords = new Set(remoteData.value)

  loading.value = true
  error.value = null

  try {
    const result = await fetchPingHistory(uuid, hours)

    if (requestId !== fetchRequestId)
      return

    const liveRecords = realtime
      ? remoteData.value.filter(record => !previousRecords.has(record))
      : []
    // Keep real samples that the history endpoint has not persisted yet.
    remoteData.value = mergePingRecords([
      ...(realtime
        ? remoteData.value
        : []),
      ...result.records,
      ...liveRecords,
    ])
    tasks.value = [
      ...result.tasks,
      ...tasks.value.filter(task => remoteData.value.some(record => record.task_id === task.id)
        && !result.tasks.some(item => item.id === task.id)),
    ]

    if (selectAllTasks) {
      selectedTaskIds.value = tasks.value.map(t => t.id)
    }
  }
  catch (err) {
    if (requestId !== fetchRequestId)
      return

    error.value = err instanceof Error
      ? err.message
      : '获取数据失败'
  }
  finally {
    if (requestId === fetchRequestId) {
      loading.value = false
    }
  }
}

// ==================== 数据处理 ====================

function mergePingRecords(records: PingRecord[]): TimedPingRecord[] {
  const deduped = new Map<string, TimedPingRecord>()
  for (const record of records) {
    const timeMs = 'timeMs' in record && typeof (record as TimedPingRecord).timeMs === 'number'
      ? (record as TimedPingRecord).timeMs
      : Date.parse(record.time)
    if (!Number.isFinite(timeMs))
      continue
    deduped.set(`${record.task_id}:${record.time}`, { ...record, timeMs })
  }
  const merged = [
    ...deduped.values(),
  ].sort((a, b) => a.timeMs - b.timeMs)
  if (!merged.length)
    return []
  const cutoff = merged.at(-1)!.timeMs - selectedHours.value * 3_600_000
  return merged.filter(record => record.timeMs >= cutoff)
}

const mergedData = computed(() => {
  const data = remoteData.value
  if (!data.length)
    return []

  const grouped: Map<number, Record<string, unknown>> = new Map()

  for (const rec of data) {
    const ts = rec.timeMs
    if (!grouped.has(ts))
      grouped.set(ts, { time: ts })

    const group = grouped.get(ts)!
    group[rec.task_id] = Number.isFinite(rec.value) && rec.value >= 0
      ? rec.value
      : null
    group[`timeout_${rec.task_id}`] = rec.value < 0
  }

  return Array.from(grouped.values()).sort(
    (a, b) => (a.time as number) - (b.time as number),
  )
})

const chartData = computed(() => {
  let data = mergedData.value
  const selectedKeys = selectedTasks.value.map(task => String(task.id))

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

const showDateInAxis = computed(() => selectedHours.value >= 24)

// ==================== 任务选择 ====================

// 任务颜色（根据任务在完整列表中的索引）
const taskColors = computed(() => new Map(tasks.value.map((task, idx) => [task.id, chartColors[idx % chartColors.length]!])))

function finiteMetric(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number)
    ? number
    : undefined
}

function average(values: number[]): number | undefined {
  if (!values.length)
    return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted: number[], ratio: number): number | undefined {
  if (!sorted.length)
    return undefined
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function sampleIntervalSeconds(records: TimedPingRecord[]): number | undefined {
  const timestamps = [
    ...new Set(records.map(record => record.timeMs)),
  ]
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
  return seconds > 0
    ? seconds
    : undefined
}

// 优先使用当前查询周期内的原始样本，缺少时才回退到接口聚合字段。
const latestValues = computed(() => {
  if (!tasks.value.length)
    return []

  const recordsByTask = new Map<number, TimedPingRecord[]>()
  for (const record of remoteData.value) {
    const list = recordsByTask.get(record.task_id)
    if (list)
      list.push(record)
    else
      recordsByTask.set(record.task_id, [record])
  }
  return tasks.value.map((task) => {
    const taskRecords = recordsByTask.get(task.id) ?? []
    const latencyRecords = taskRecords.filter(record => record.value >= 0)
    const latencyValues = latencyRecords.map(record => record.value)
    const sortedLatency = [...latencyValues].sort((a, b) => a - b)
    const lossValues = taskRecords
      .map(record => finiteMetric(record.loss))
      .filter((value): value is number => value !== undefined)
    const latestRecord = taskRecords.at(-1)
    const latest = latestRecord && Number.isFinite(latestRecord.value) && latestRecord.value >= 0
      ? latestRecord.value
      : undefined
    const p50 = percentile(sortedLatency, 0.5)
    const p99 = percentile(sortedLatency, 0.99)

    return {
      ...task,
      min: sortedLatency[0],
      max: sortedLatency.at(-1),
      avg: average(latencyValues),
      latest,
      timedOut: latestRecord !== undefined && latestRecord.value < 0,
      p50,
      p99,
      p99_p50_ratio: p50 && p99
        ? p99 / p50
        : undefined,
      interval: sampleIntervalSeconds(latencyRecords) ?? finiteMetric(task.interval),
      loss: average(lossValues) ?? finiteMetric(task.loss),
      total: latencyRecords.length || undefined,
      color: taskColors.value.get(task.id)!,
    }
  })
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
      tasks.value = [
        ...tasks.value,
        { id: taskId, key, name: ping.name },
      ]
      if (selectAllTasks && !selectedTaskIds.value.includes(taskId))
        selectedTaskIds.value = [...selectedTaskIds.value, taskId]
    }

    return [
      {
        client: props.uuid,
        task_id: taskId,
        time: sample.time,
        value: ping.loss === 100
          ? -1
          : ping.latest,
        loss: Number.isFinite(ping.loss)
          ? ping.loss
          : undefined,
      },
    ]
  })

  if (!records.length)
    return

  remoteData.value = mergePingRecords([
    ...remoteData.value,
    ...records,
  ])
}

const packetLossMarkers = computed(() => {
  const markers = new Map<number, number[]>()
  for (const task of selectedTasks.value) {
    const timestamps = remoteData.value
      .filter(record => record.task_id === task.id
        && ((record.loss ?? 0) > 0 || record.value < 0))
      .map(record => record.timeMs)
    markers.set(task.id, [
      ...new Set(timestamps),
    ].sort((a, b) => a - b))
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
  selectAllTasks = false
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

const pingChartOption = computed(() => {
  const taskList = tasks.value
  const data = chartData.value
  const hours = selectedHours.value
  const rowsByTime = new Map(data.map(row => [row.time as number, row]))
  const selectedIdSet = new Set(selectedTaskIds.value)
  let minTs: number | undefined
  let maxTs: number | undefined
  for (const record of remoteData.value) {
    if (!selectedIdSet.has(record.task_id))
      continue
    if (minTs === undefined)
      minTs = record.timeMs
    maxTs = record.timeMs
  }

  // 构建 series，确保颜色与卡片一致
  const series = taskList.map((task) => {
    const color = taskColors.value.get(task.id) ?? chartColors[0]!
    const lossMarkerTimes = packetLossMarkers.value.get(task.id) || []
    return {
      id: String(task.id),
      name: String(task.id),
      type: 'line' as const,
      data: data.filter(d => Object.hasOwn(d, `timeout_${task.id}`))
        .map(d => [d.time as number, d[task.id] as number | null ?? null]),
      smooth: showDelay.value
        ? (cutPeak.value ? 0.6 : 0.1)
        : 0,
      showSymbol: false,
      connectNulls: false,
      lineStyle: {
        width: showDelay.value ? 1.5 : 0,
        color,
        cap: 'round' as const,
      },
      itemStyle: {
        color,
        opacity: showDelay.value ? 1 : 0,
      },
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

  const colorMap = taskColors.value

  return {
    animation: false,
    // 全局颜色设置（用于图例等）
    color: [
      ...colorMap.values(),
    ],
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ seriesId: string, value: [number, number | null] }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const time = firstParam.value[0]
        const paramByTaskId = new Map(p.map(item => [item.seriesId, item]))
        const timeStr = formatChartTooltipTime(time, hours)
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'

        // 按延迟从高到低显示，与曲线上下位置一致，仅包含图例中可见的线路
        const sortedParams = taskList.filter(task => paramByTaskId.has(String(task.id))).map((task) => {
          const item = paramByTaskId.get(String(task.id))!
          const itemRow = rowsByTime.get(item.value[0])
          const value = itemRow ? (itemRow[task.id] as number | null) : item.value[1]
          return {
            taskId: task.id,
            seriesName: task.name,
            value,
            timedOut: itemRow?.[`timeout_${task.id}`] === true,
          }
        }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

        for (const item of sortedParams) {
          if (item.timedOut || (item.value !== null && item.value !== undefined)) {
            const color = colorMap.get(item.taskId) || chartColors[0]!
            const valueText = item.timedOut
              ? '超时'
              : `${Math.round(item.value!)} ms`
            html += renderTooltipRow(color, item.seriesName, valueText, true)
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
      // Use task IDs so lines with the same display name remain independently selectable.
      data: taskList.map(task => String(task.id)),
      formatter: (name: string) => taskList.find(task => String(task.id) === name)?.name ?? name,
      selected: Object.fromEntries(taskList.map(task => [
        String(task.id),
        selectedTaskIds.value.includes(task.id),
      ])),
    },
    grid: chartMargin,
    xAxis: {
      type: 'time',
      min: minTs,
      max: maxTs,
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
  remoteData.value = []
  tasks.value = []
  fetchRecords()
})

watch(() => props.uuid, () => {
  selectAllTasks = true
  remoteData.value = []
  tasks.value = []
  selectedTaskIds.value = []
  fetchRecords()
})

// 仅在断线重连 / 前台恢复同步时重拉历史，避免首页进详情页重复请求
watch(() => nodesStore.resyncVersion, () => {
  if (nodeInfo.value)
    fetchRecords()
}, { flush: 'sync' })

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
    <Tabs v-model="selectedView" class="w-full flex-row items-center">
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
          :class="[tasks.length > 0 && selectedTasks.length === tasks.length && 'bg-background !text-emerald-600']"
          @click="showAllTasks"
        >
          全选
        </Button>
        <Button
          variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
          :class="[tasks.length > 0 && !selectedTasks.length && 'bg-background !text-emerald-600']"
          @click="hideAllTasks"
        >
          全不选
        </Button>
      </div>
    </Tabs>

    <!-- 内容区域 -->
    <Spinner :show="loading" class="flex flex-col gap-4">
      <div v-if="error" class="text-red-500 py-8 text-center">
        {{ error }}
      </div>
      <div v-if="!error && tasks.length === 0 && !loading" class="py-8">
        <Empty description="暂无延迟数据" />
      </div>

      <template v-else-if="tasks.length > 0 || loading">
        <!-- 最新值统计卡片（可点击切换选中状态） -->
        <div
          v-if="latestValues.length > 0" class="gap-3 grid"
          style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))"
        >
          <div
            v-for="task in latestValues" :key="task.id"
            class="flex cursor-pointer select-none items-center gap-3 rounded-md p-2 transition-all bg-background/60 hover:bg-background hover:shadow-[0_0_0_1px] hover:shadow-emerald-600/10"
            :class="[
              !selectedTaskIds.includes(task.id) && 'opacity-30',
            ]"
            @click="toggleTask(task.id)"
          >
            <div class="flex-1 min-w-0">
              <div class="flex gap-2 items-center">
                <div class="rounded h-4 w-1 shrink-0" :style="{ backgroundColor: task.color }" />
                <button
                  type="button" :aria-pressed="selectedTaskIds.includes(task.id)"
                  class="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @click.stop="toggleTask(task.id)"
                >
                  {{ task.name }}
                </button>
                <div class="flex-1" />
                <DataTooltip placement="left" content-class="!rounded p-3 w-60 backdrop-blur">
                  <Button variant="ghost" size="icon-xs" class="text-slate-500" :aria-label="`${task.name}线路统计`" @click.stop>
                    <Icon icon="carbon:information" :width="14" :height="14" />
                  </Button>
                  <template #content>
                    <div class="text-xs gap-x-4 gap-y-1.5 grid grid-cols-4 tabular-nums">
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
                      <template v-if="task.loss !== undefined">
                        <span class="text-muted-foreground">丢包</span>
                        <span class="font-medium">{{ task.loss.toFixed(2) }}%</span>
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
                      <template v-if="task.total !== undefined">
                        <span class="text-muted-foreground">总数</span>
                        <span class="font-medium">{{ task.total }}</span>
                      </template>
                    </div>
                  </template>
                </DataTooltip>
              </div>
              <div class="text-xs mt-1 flex gap-1.5 items-center text-muted-foreground tabular-nums">
                <DataTooltip
                  v-if="task.timedOut" as="span" placement="cursor" touch-behavior="passthrough" content="最新探测"
                  class="text-rose-500 rounded-sm"
                >
                  <span class="sr-only">最新探测 </span>超时 ·
                </DataTooltip>
                <DataTooltip
                  as="span" placement="cursor" touch-behavior="passthrough" content="平均延迟"
                  class="font-medium rounded-sm"
                >
                  <span class="sr-only">平均延迟 </span>{{ task.avg !== undefined ? `${Math.round(task.avg)}ms` : '-' }}
                </DataTooltip>
                <template v-if="task.loss !== undefined">
                  <span class="opacity-60" aria-hidden="true">·</span>
                  <DataTooltip
                    as="span" placement="cursor" touch-behavior="passthrough" content="丢包率"
                    class="rounded-sm"
                  >
                    <span class="sr-only">丢包率 </span>{{ task.loss.toFixed(2) }}%
                  </DataTooltip>
                </template>
                <template v-if="task.p99_p50_ratio !== undefined">
                  <span class="opacity-60" aria-hidden="true">·</span>
                  <DataTooltip
                    as="span" placement="cursor" touch-behavior="passthrough" content="波动率"
                    class="rounded-sm"
                  >
                    <span class="sr-only">波动率 </span>{{ task.p99_p50_ratio.toFixed(2) }}
                  </DataTooltip>
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
          <VChart
            :option="pingChartOption" :update-options="{ replaceMerge: ['series'] }" autoresize
            @legendselectchanged="toggleTask(Number($event.name))"
          />
        </div>
      </template>
    </Spinner>
  </div>
</template>
