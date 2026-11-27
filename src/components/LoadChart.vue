<script setup lang="ts">
import type { RecordFormat } from '@/utils/recordHelper'
import type { StatusRecord } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import dayjs from 'dayjs'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { CardX } from '@/components/ui/card-x'
import { Empty } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { formatChartTooltipTime, renderTooltipRow, useChartTheme } from '@/composables/useChartTheme'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { fetchLoadHistory } from '@/utils/api'
import { DEFAULT_CHART_TIME_RANGE, getAvailableChartTimeRanges } from '@/utils/chartTimeRange'
import { formatBytes, formatBytesSplit } from '@/utils/helper'

const props = defineProps<{
  uuid: string
}>()

const VChart = defineAsyncComponent(() => import('@/utils/echarts'))

const appStore = useAppStore()
const { pickSurfaceClass } = useBackgroundSurface()
const nodesStore = useNodesStore()

// 从 publicSettings 获取记录保留时间（未加载完成前按匿名上限 24 小时兜底）
const maxRecordPreserveTime = computed(() => appStore.publicSettings?.record_preserve_time || 24)

const { chartThemeColors, baseTooltipConfig } = useChartTheme()

// 优化后的图表配色方案（基于 Material Design 色彩）
const chartColors = {
  // 主色调 - 珊瑚红
  primary: '#FF6B6B',
  primaryArea: 'rgba(255, 107, 107, 0.15)',
  // 次要色 - 琥珀黄
  secondary: '#FFB347',
  // 第三色 - 青绿色
  tertiary: '#4ECDC4',
  // 第四色 - 紫罗兰
  quaternary: '#A78BFA',
  // 第五色 - 天蓝色
  quinary: '#60A5FA',
}

// 图表边距配置
const chartMargin = {
  top: 30,
  right: 24,
  bottom: 32,
  left: 56,
}
const chartMarginWithLegend = {
  top: 30,
  right: 24,
  bottom: 52,
  left: 56,
}

// 可用视图列表
const availableViews = computed(() => getAvailableChartTimeRanges(maxRecordPreserveTime.value))

// 当前选中的视图
const selectedView = ref<string>(DEFAULT_CHART_TIME_RANGE.label)
const selectedHours = computed(() => {
  const view = availableViews.value.find(v => v.label === selectedView.value)
  return view?.hours ?? DEFAULT_CHART_TIME_RANGE.hours
})
const isRealtime = computed(() => selectedView.value === DEFAULT_CHART_TIME_RANGE.label)

watch(availableViews, (views) => {
  if (!views.some(view => view.label === selectedView.value))
    selectedView.value = views[0]?.label ?? DEFAULT_CHART_TIME_RANGE.label
}, { immediate: true })

// 数据状态
const remoteData = shallowRef<StatusRecord[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let fetchRequestId = 0

// 节点信息
const nodeInfo = computed(() => nodesStore.nodesByUuid.get(props.uuid))

// ==================== 数据获取 ====================

interface TimedRecordFormat extends RecordFormat {
  timeMs: number
}

function createGapBreakRecord(client: string, timeMs: number): TimedRecordFormat {
  return {
    client,
    time: new Date(timeMs).toISOString(),
    timeMs,
    cpu: null,
    gpu: null,
    ram: null,
    ram_total: null,
    swap: null,
    swap_total: null,
    load: null,
    temp: null,
    disk: null,
    disk_total: null,
    net_in: null,
    net_out: null,
    net_total_up: null,
    net_total_down: null,
    process: null,
    connections: null,
    connections_udp: null,
  }
}

function statusToRecordFormat(records: StatusRecord[]): TimedRecordFormat[] {
  const result: TimedRecordFormat[] = []
  for (const r of records) {
    const timeMs = Date.parse(r.time)
    if (!Number.isFinite(timeMs))
      continue
    result.push({
      client: r.client,
      time: r.time,
      timeMs,
      cpu: r.cpu ?? null,
      gpu: r.gpu ?? null,
      ram: r.ram ?? null,
      ram_total: r.ram_total ?? null,
      swap: r.swap ?? null,
      swap_total: r.swap_total ?? null,
      load: r.load ?? null,
      temp: r.temp ?? null,
      disk: r.disk ?? null,
      disk_total: r.disk_total ?? null,
      net_in: r.net_in ?? null,
      net_out: r.net_out ?? null,
      net_total_up: r.net_total_up ?? null,
      net_total_down: r.net_total_down ?? null,
      process: r.process ?? null,
      connections: r.connections ?? null,
      connections_udp: r.connections_udp ?? null,
    })
  }
  return result
}

// 实时视图只保留所选时间窗内的数据，避免长时间驻留后横向漂移；以最后一条数据点为锚，避免时钟偏差
function trimToSelectedWindow(records: StatusRecord[]): StatusRecord[] {
  const windowMs = (selectedHours.value || DEFAULT_CHART_TIME_RANGE.hours) * 3600 * 1000
  const lastMs = Date.parse(records.at(-1)?.time ?? '')
  if (!Number.isFinite(lastMs))
    return records
  const cutoff = lastMs - windowMs
  return records.filter(record => Date.parse(record.time) >= cutoff)
}

function nodeToStatusRecord(node: NonNullable<typeof nodeInfo.value>): StatusRecord {
  return {
    client: node.uuid,
    time: node.time,
    cpu: node.cpu,
    gpu: node.gpu,
    ram: node.ram,
    ram_total: node.mem_total,
    swap: node.swap,
    swap_total: node.swap_total,
    load: node.load,
    load5: node.load5,
    load15: node.load15,
    temp: node.temp,
    disk: node.disk,
    disk_total: node.disk_total,
    net_in: node.net_in,
    net_out: node.net_out,
    net_total_up: node.net_total_up,
    net_total_down: node.net_total_down,
    net_monthly_up: node.net_monthly_up,
    net_monthly_down: node.net_monthly_down,
    process: node.process,
    connections: node.connections,
    connections_udp: node.connections_udp,
  }
}

function appendRealtimeStatus(node: NonNullable<typeof nodeInfo.value>): void {
  if (!isRealtime.value || !node.time)
    return

  const next = nodeToStatusRecord(node)
  const nextTime = Date.parse(next.time)
  const lastTime = Date.parse(remoteData.value.at(-1)?.time ?? '')
  if (!Number.isFinite(nextTime) || (Number.isFinite(lastTime) && nextTime <= lastTime))
    return

  remoteData.value = trimToSelectedWindow([...remoteData.value, next])
}

async function fetchData() {
  if (!props.uuid)
    return

  const requestId = ++fetchRequestId
  const uuid = props.uuid
  const hours = selectedHours.value
  const realtime = isRealtime.value
  const previousRecords = new Set(remoteData.value)
  loading.value = true
  error.value = null

  try {
    const result = await fetchLoadHistory(uuid, hours)
    if (requestId !== fetchRequestId)
      return

    const liveRecords = realtime
      ? remoteData.value.filter(record => !previousRecords.has(record))
      : []
    // History persistence can lag behind samples already displayed before this request.
    const mergedMap = new Map([
      ...(realtime
        ? remoteData.value
        : []),
      ...result,
      ...liveRecords,
    ].map(record => [record.time, record]))
    const records = Array.from(mergedMap.values(), record => ({
      record,
      timeMs: Date.parse(record.time),
    }))
      .filter(item => Number.isFinite(item.timeMs))
      .sort((a, b) => a.timeMs - b.timeMs)
      .map(item => item.record)

    remoteData.value = trimToSelectedWindow(records)
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

const chartData = computed<TimedRecordFormat[]>(() => {
  const data = statusToRecordFormat(remoteData.value)
  if (data.length < 2)
    return data

  // 保留后端返回的全部真实采样点，仅在明显断档中点插入 null 断点以便 connectNulls=false 断开折线
  const hours = selectedHours.value || DEFAULT_CHART_TIME_RANGE.hours
  const longHistoryPoints = appStore.publicSettings?.long_history_points || 120
  const expectedStepMs = isRealtime.value
    ? 60_000
    : (hours * 3_600_000) / longHistoryPoints
  const gapThresholdMs = Math.max(expectedStepMs * 2.5, 5 * 60_000)

  const withGaps: TimedRecordFormat[] = [data[0]!]
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1]!
    const curr = data[i]!
    if (curr.timeMs - prev.timeMs > gapThresholdMs) {
      withGaps.push(createGapBreakRecord(prev.client, Math.floor((prev.timeMs + curr.timeMs) / 2)))
    }
    withGaps.push(curr)
  }
  return withGaps
})

const latestStatus = computed(() => {
  const data = remoteData.value
  if (!data.length)
    return null
  return data.at(-1) ?? null
})
const swapTotal = computed(() => latestStatus.value?.swap_total ?? nodeInfo.value?.swap_total)
const latestFormatted = computed(() => ({
  ram: latestStatus.value?.ram != null
    ? formatBytesSplit(latestStatus.value.ram)
    : null,
  memTotal: (nodeInfo.value?.mem_total || latestStatus.value?.ram_total)
    ? formatBytesSplit(nodeInfo.value?.mem_total || latestStatus.value?.ram_total || 0)
    : null,
  swap: latestStatus.value?.swap != null
    ? formatBytesSplit(latestStatus.value.swap)
    : null,
  swapTotal: swapTotal.value != null
    ? formatBytesSplit(swapTotal.value)
    : null,
  disk: latestStatus.value?.disk != null
    ? formatBytesSplit(latestStatus.value.disk)
    : null,
  diskTotal: (nodeInfo.value?.disk_total || latestStatus.value?.disk_total)
    ? formatBytesSplit(nodeInfo.value?.disk_total || latestStatus.value?.disk_total || 0)
    : null,
  netOut: latestStatus.value?.net_out != null
    ? formatBytesSplit(latestStatus.value.net_out)
    : null,
  netIn: latestStatus.value?.net_in != null
    ? formatBytesSplit(latestStatus.value.net_in)
    : null,
}))

// ==================== 工具函数 ====================

function formatTime(time: number, showDate: boolean): string {
  const date = dayjs(time)
  if (showDate) {
    return date.format('M/D HH:mm')
  }
  return date.format(isRealtime.value ? 'HH:mm:ss' : 'HH:mm')
}

const showDateInAxis = computed(() => (selectedHours.value || 1) >= 24)
const showSinglePointSymbol = computed(() => chartData.value.length === 1)

// 通用 X 轴配置（使用真实时间戳，完整保留后端采样精度）
const baseXAxisConfig = computed(() => {
  const data = chartData.value
  const firstTime = data[0]?.timeMs
  const lastTime = data.at(-1)?.timeMs
  const isSinglePoint = firstTime !== undefined && firstTime === lastTime
  return {
    type: 'time' as const,
    min: isSinglePoint
      ? firstTime - 60_000
      : firstTime,
    max: isSinglePoint
      ? lastTime + 60_000
      : lastTime,
    axisLabel: {
      formatter: (value: number) => formatTime(value, showDateInAxis.value),
      fontSize: 11,
      color: chartThemeColors.value.textSecondary,
      margin: 12,
      hideOverlap: true,
    },
    axisLine: {
      show: true,
      lineStyle: { color: chartThemeColors.value.borderColor, width: 1 },
    },
    axisTick: { show: false },
    boundaryGap: false,
  }
})

// 通用 Y 轴配置
const baseYAxisConfig = computed(() => ({
  type: 'value' as const,
  axisLabel: {
    fontSize: 11,
    color: chartThemeColors.value.textSecondary,
  },
  axisLine: { show: false },
  axisTick: { show: false },
  splitLine: {
    lineStyle: {
      color: chartThemeColors.value.splitLineColor,
      type: 'dashed' as const,
    },
  },
  axisPointer: {
    lineStyle: { opacity: 0 },
    crossStyle: { opacity: 0 },
    label: { show: false },
  },
}))

// ==================== 图表配置 ====================

// CPU 图表
const cpuChartOption = computed(() => ({
  animation: false,
  // 全局颜色配置（确保 Tooltip 圆点颜色与线条一致）
  color: [chartColors.primary, chartColors.secondary],
  tooltip: {
    ...baseTooltipConfig.value,
    formatter: (params: unknown) => {
      const p = (params as Array<{ dataIndex: number, seriesName: string, value: [number, number | null], color: string }>).filter(item => Number.isFinite(item.value?.[1]))
      if (!p.length)
        return ''
      const firstParam = p[0]
      if (!firstParam)
        return ''
      const record = chartData.value[firstParam.dataIndex]
      if (!record)
        return ''

      const timeStr = formatChartTooltipTime(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const val = item.value[1]
        if (item.seriesName === 'CPU') {
          html += renderTooltipRow(item.color, 'CPU', `${val?.toFixed(1) ?? '-'}%`)
        }
        else if (item.seriesName === '负载') {
          html += renderTooltipRow(item.color, '系统负载', `${val?.toFixed(2) ?? '-'}`)
        }
      }
      html += '</div>'
      return html
    },
  },
  grid: chartMargin,
  xAxis: baseXAxisConfig.value,
  yAxis: [
    {
      ...baseYAxisConfig.value,
      name: 'CPU %',
      nameTextStyle: {
        color: chartThemeColors.value.textSecondary,
        padding: [0, 40, 0, 0],
      },
      min: 0,
      max: 100,
      axisLabel: { ...baseYAxisConfig.value.axisLabel, formatter: '{value}%' },
    },
    {
      ...baseYAxisConfig.value,
      name: '负载',
      nameTextStyle: {
        color: chartThemeColors.value.textSecondary,
        padding: [0, 0, 0, 40],
      },
      min: 0,
      splitLine: { show: false },
    },
  ],
  series: [
    {
      name: 'CPU',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.cpu]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      yAxisIndex: 0,
      lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(255, 107, 107, 0.25)' },
            { offset: 1, color: 'rgba(255, 107, 107, 0.02)' },
          ],
        },
      },
    },
    {
      name: '负载',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.load]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      yAxisIndex: 1,
      lineStyle: { width: 1.5, color: chartColors.secondary, cap: 'round' as const },
    },
  ],
}))

// 内存图表
const memoryChartOption = computed(() => ({
  animation: false,
  color: [chartColors.primary, chartColors.secondary],
  tooltip: {
    ...baseTooltipConfig.value,
    formatter: (params: unknown) => {
      const p = (params as Array<{ dataIndex: number, seriesName: string, value: [number, number | null], color: string }>).filter(item => Number.isFinite(item.value?.[1]))
      if (!p.length)
        return ''
      const firstParam = p[0]
      if (!firstParam)
        return ''
      const record = chartData.value[firstParam.dataIndex]
      if (!record)
        return ''

      const ramUsed = record.ram ?? 0
      const ramTotal = record.ram_total || nodeInfo.value?.mem_total || 0
      const swapUsed = record.swap ?? 0
      const swapTotal = record.swap_total ?? nodeInfo.value?.swap_total
      const ramPercent = ramTotal > 0
        ? ((ramUsed / ramTotal) * 100).toFixed(1)
        : '0'
      const swapPercent = swapTotal == null
        ? ''
        : ` (${swapTotal > 0
          ? ((swapUsed / swapTotal) * 100).toFixed(1)
          : '0'}%)`

      const timeStr = formatChartTooltipTime(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        if (item.seriesName === 'RAM') {
          html += renderTooltipRow(item.color, 'RAM', `${formatBytes(ramUsed)} (${ramPercent}%)`)
        }
        else if (item.seriesName === 'Swap' && record.swap !== null) {
          html += renderTooltipRow(item.color, 'Swap', `${formatBytes(swapUsed)}${swapPercent}`)
        }
      }
      html += '</div>'
      return html
    },
  },
  grid: chartMargin,
  xAxis: baseXAxisConfig.value,
  yAxis: {
    ...baseYAxisConfig.value,
    name: '内存',
    nameTextStyle: {
      color: chartThemeColors.value.textSecondary,
      padding: [0, 40, 0, 0],
    },
    axisLabel: {
      ...baseYAxisConfig.value.axisLabel,
      formatter: (val: number) => formatBytes(val),
    },
  },
  series: [
    {
      name: 'RAM',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.ram]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(255, 107, 107, 0.25)' },
            { offset: 1, color: 'rgba(255, 107, 107, 0.02)' },
          ],
        },
      },
    },
    {
      name: 'Swap',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.swap]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.secondary, cap: 'round' as const },
    },
  ],
}))

// 磁盘图表
const diskChartOption = computed(() => ({
  animation: false,
  color: [chartColors.tertiary],
  tooltip: {
    ...baseTooltipConfig.value,
    formatter: (params: unknown) => {
      const p = (params as Array<{ dataIndex: number, value: [number, number | null], color: string }>).filter(item => Number.isFinite(item.value?.[1]))
      if (!p.length)
        return ''
      const firstParam = p[0]
      if (!firstParam)
        return ''
      const record = chartData.value[firstParam.dataIndex]
      if (!record)
        return ''

      const diskUsed = record.disk ?? 0
      const diskTotal = record.disk_total || nodeInfo.value?.disk_total || 0
      const diskPercent = diskTotal > 0
        ? ((diskUsed / diskTotal) * 100).toFixed(1)
        : '0'

      const timeStr = formatChartTooltipTime(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'
      html += renderTooltipRow(firstParam.color, '磁盘已用', `${formatBytes(diskUsed)} (${diskPercent}%)`)
      html += '</div>'
      return html
    },
  },
  grid: chartMargin,
  xAxis: baseXAxisConfig.value,
  yAxis: {
    ...baseYAxisConfig.value,
    name: '磁盘',
    nameTextStyle: {
      color: chartThemeColors.value.textSecondary,
      padding: [0, 40, 0, 0],
    },
    axisLabel: {
      ...baseYAxisConfig.value.axisLabel,
      formatter: (val: number) => formatBytes(val),
    },
  },
  series: [
    {
      name: '磁盘已用',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.disk]),
      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.tertiary, cap: 'round' as const },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(78, 205, 196, 0.25)' },
            { offset: 1, color: 'rgba(78, 205, 196, 0.02)' },
          ],
        },
      },
    },
  ],
}))

// 网络图表
const networkChartOption = computed(() => ({
  animation: false,
  color: [chartColors.quinary, chartColors.quaternary],
  tooltip: {
    ...baseTooltipConfig.value,
    formatter: (params: unknown) => {
      const p = (params as Array<{ dataIndex: number, seriesName: string, value: [number, number | null], color: string }>).filter(item => Number.isFinite(item.value?.[1]))
      if (!p.length)
        return ''
      const firstParam = p[0]
      if (!firstParam)
        return ''
      const record = chartData.value[firstParam.dataIndex]
      if (!record)
        return ''

      const timeStr = formatChartTooltipTime(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const label = item.seriesName === '下载'
          ? '↓ 下载'
          : '↑ 上传'
        html += renderTooltipRow(item.color, label, `${formatBytes(item.value[1]!)}/s`)
      }
      html += '</div>'
      return html
    },
  },
  legend: {
    data: ['下载', '上传'],
    bottom: 4,
    itemWidth: 12,
    itemHeight: 12,
    itemGap: 20,
    icon: 'roundRect',
    textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
  },
  grid: chartMarginWithLegend,
  xAxis: baseXAxisConfig.value,
  yAxis: {
    ...baseYAxisConfig.value,
    name: '速度',
    nameTextStyle: {
      color: chartThemeColors.value.textSecondary,
      padding: [0, 40, 0, 0],
    },
    axisLabel: {
      ...baseYAxisConfig.value.axisLabel,
      formatter: (val: number) => `${formatBytes(val)}/s`,
    },
  },
  series: [
    {
      name: '下载',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.net_in]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.quinary, cap: 'round' as const },
    },
    {
      name: '上传',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.net_out]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.quaternary, cap: 'round' as const },
    },
  ],
}))

// 连接数图表
const connectionsChartOption = computed(() => ({
  animation: false,
  color: [chartColors.primary, chartColors.tertiary],
  tooltip: {
    ...baseTooltipConfig.value,
    formatter: (params: unknown) => {
      const p = (params as Array<{ dataIndex: number, seriesName: string, value: [number, number | null], color: string }>).filter(item => Number.isFinite(item.value?.[1]))
      if (!p.length)
        return ''
      const firstParam = p[0]
      if (!firstParam)
        return ''
      const record = chartData.value[firstParam.dataIndex]
      if (!record)
        return ''

      const timeStr = formatChartTooltipTime(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const displayValue = item.value[1] != null
          ? String(Math.round(item.value[1]))
          : '-'
        html += renderTooltipRow(item.color, item.seriesName, displayValue)
      }
      html += '</div>'
      return html
    },
  },
  legend: {
    data: ['TCP', 'UDP'],
    bottom: 4,
    itemWidth: 12,
    itemHeight: 12,
    itemGap: 20,
    icon: 'roundRect',
    textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
  },
  grid: chartMarginWithLegend,
  xAxis: baseXAxisConfig.value,
  yAxis: {
    ...baseYAxisConfig.value,
    name: '连接数',
    nameTextStyle: {
      color: chartThemeColors.value.textSecondary,
      padding: [0, 40, 0, 0],
    },
    min: 0,
    axisLabel: {
      ...baseYAxisConfig.value.axisLabel,
      formatter: (val: number) => Math.round(val).toString(),
    },
  },
  series: [
    {
      name: 'TCP',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.connections]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
    },
    {
      name: 'UDP',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.connections_udp]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.tertiary, cap: 'round' as const },
    },
  ],
}))

// 进程数图表
const processChartOption = computed(() => ({
  animation: false,
  color: [chartColors.quaternary],
  tooltip: {
    ...baseTooltipConfig.value,
    formatter: (params: unknown) => {
      const p = (params as Array<{ dataIndex: number, value: [number, number | null], color: string }>).filter(item => Number.isFinite(item.value?.[1]))
      if (!p.length)
        return ''
      const firstParam = p[0]
      if (!firstParam)
        return ''
      const record = chartData.value[firstParam.dataIndex]
      if (!record)
        return ''

      const timeStr = formatChartTooltipTime(record.time, selectedHours.value || 1)
      const displayValue = firstParam.value[1] != null
        ? String(Math.round(firstParam.value[1]))
        : '-'

      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'
      html += renderTooltipRow(firstParam.color, '进程数', displayValue)
      html += '</div>'
      return html
    },
  },
  grid: chartMargin,
  xAxis: baseXAxisConfig.value,
  yAxis: {
    ...baseYAxisConfig.value,
    name: '进程',
    nameTextStyle: {
      color: chartThemeColors.value.textSecondary,
      padding: [0, 40, 0, 0],
    },
    min: 0,
    axisLabel: {
      ...baseYAxisConfig.value.axisLabel,
      formatter: (val: number) => Math.round(val).toString(),
    },
  },
  series: [
    {
      name: '进程数',
      type: 'line',
      data: chartData.value.map(r => [r.timeMs, r.process]),

      showSymbol: showSinglePointSymbol.value,
      connectNulls: false,
      lineStyle: { width: 1.5, color: chartColors.quaternary, cap: 'round' as const },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(167, 139, 250, 0.25)' },
            { offset: 1, color: 'rgba(167, 139, 250, 0.02)' },
          ],
        },
      },
    },
  ],
}))

// 生命周期 ====================

// 仅在断线重连 / 前台恢复同步时重拉历史，避免首页进详情页重复请求
watch(() => nodesStore.resyncVersion, () => {
  if (nodeInfo.value)
    fetchData()
}, { flush: 'sync' })

watch(() => nodeInfo.value?.time, () => {
  const node = nodeInfo.value
  if (node)
    appendRealtimeStatus(node)
})

watch(selectedView, () => {
  remoteData.value = []
  fetchData()
})

watch(() => props.uuid, () => {
  remoteData.value = []
  fetchData()
})

onMounted(() => {
  fetchData()
})

onBeforeUnmount(() => fetchRequestId++)
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 时间选择器 -->
    <Tabs v-model="selectedView" class="w-full flex-row items-center">
      <TabsList :class="pickSurfaceClass('h-8 bg-background/60 pointer-events-auto rounded-md', 'h-8 bg-background/50 backdrop-blur-xl pointer-events-auto rounded-md')">
        <TabsTrigger
          v-for="view in availableViews" :key="view.label" :value="view.label"
          class="h-6.5 text-xs border-none data-[state=active]:text-emerald-600 shadow-none rounded-sm"
        >
          {{ view.label }}
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <!-- 内容区域 -->
    <Spinner :show="loading">
      <div v-if="error" class="text-red-500 py-8 text-center">
        {{ error }}
      </div>
      <div v-if="!error && remoteData.length === 0 && !loading" class="py-8">
        <Empty description="暂无负载数据" />
      </div>

      <!-- 图表网格 -->
      <div v-else-if="remoteData.length > 0 || loading" class="gap-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <!-- CPU 卡片 -->
        <CardX
          size="small"
          class="border-none transition-all rounded-md"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xs')"
        >
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">CPU</span>
              <div v-if="latestStatus?.cpu != null" class="text-xs flex gap-0.5 items-baseline tabular-nums">
                <span>{{ latestStatus.cpu.toFixed(1) }}</span>
                <span>%</span>
              </div>
              <span v-else>-</span>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="cpuChartOption" autoresize />
          </div>
        </CardX>

        <!-- 内存卡片 -->
        <CardX
          size="small"
          class="border-none transition-all rounded-md"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xs')"
        >
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">内存</span>
              <div class="text-xs flex gap-1 items-baseline tabular-nums">
                <template v-if="latestFormatted.ram">
                  <span>{{ latestFormatted.ram.value }}</span>
                  <span>{{ latestFormatted.ram.unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="latestFormatted.memTotal">
                  <span>{{ latestFormatted.memTotal.value }}</span>
                  <span>{{ latestFormatted.memTotal.unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </div>
            <div class="mt-1 flex items-center justify-between text-xs">
              <span class="text-muted-foreground">Swap</span>
              <div class="flex gap-1 items-baseline tabular-nums">
                <template v-if="latestFormatted.swap">
                  <span>{{ latestFormatted.swap.value }}</span>
                  <span>{{ latestFormatted.swap.unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="latestFormatted.swapTotal">
                  <span>{{ latestFormatted.swapTotal.value }}</span>
                  <span>{{ latestFormatted.swapTotal.unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="memoryChartOption" autoresize />
          </div>
        </CardX>

        <!-- 磁盘卡片 -->
        <CardX
          size="small"
          class="border-none transition-all rounded-md"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xs')"
        >
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">磁盘</span>
              <div class="text-xs flex gap-1 items-baseline tabular-nums">
                <template v-if="latestFormatted.disk">
                  <span>{{ latestFormatted.disk.value }}</span>
                  <span>{{ latestFormatted.disk.unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="latestFormatted.diskTotal">
                  <span>{{ latestFormatted.diskTotal.value }}</span>
                  <span>{{ latestFormatted.diskTotal.unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="diskChartOption" autoresize />
          </div>
        </CardX>

        <!-- 网络卡片 -->
        <CardX
          size="small"
          class="border-none transition-all rounded-md"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xs')"
        >
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">网络</span>
              <div class="text-xs flex gap-2 items-baseline tabular-nums">
                <span class="flex flex-row items-center justify-center gap-0.5">
                  <Icon icon="tabler:chevron-up" width="12" height="12" />
                  <template v-if="latestFormatted.netOut">
                    {{ latestFormatted.netOut.value }}
                    {{ latestFormatted.netOut.unit }}/s
                  </template>
                  <template v-else>-</template>
                </span>
                <span class="flex flex-row items-center justify-center gap-0.5">
                  <Icon icon="tabler:chevron-down" width="12" height="12" />
                  <template v-if="latestFormatted.netIn">
                    {{ latestFormatted.netIn.value }}
                    {{ latestFormatted.netIn.unit }}/s
                  </template>
                  <template v-else>-</template>
                </span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="networkChartOption" autoresize />
          </div>
        </CardX>

        <!-- 连接数卡片 -->
        <CardX
          size="small"
          class="border-none transition-all rounded-md"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xs')"
        >
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">连接</span>
              <div class="text-xs flex gap-1 items-baseline tabular-nums">
                <span>TCP: {{ latestStatus?.connections ?? '-' }}</span>
                <span>·</span>
                <span>UDP: {{ latestStatus?.connections_udp ?? '-' }}</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="connectionsChartOption" autoresize />
          </div>
        </CardX>

        <!-- 进程卡片 -->
        <CardX
          size="small"
          class="border-none transition-all rounded-md"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xs')"
        >
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">进程</span>
              <span class="text-xs tabular-nums">
                {{ latestStatus?.process ?? '-' }}
              </span>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="processChartOption" autoresize />
          </div>
        </CardX>
      </div>
    </Spinner>
  </div>
</template>
