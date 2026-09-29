import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'
import { NODE_PING_BAR_COUNT, pingAverage, useNodePingStats } from '@/composables/useNodePingStats'
import { PING_HISTORY_WINDOW_MS, useNodesStore } from '@/stores/nodes'
import { formatDateTime } from '@/utils/helper'

export type NodePingMetric = 'latency' | 'loss'

export interface NodePingBar {
  key: string
  className: string
  tooltip: string
}

interface UseNodePingDisplayOptions {
  line?: MaybeRefOrGetter<string>
  enabled?: MaybeRefOrGetter<boolean>
  loadingDisplayText?: string
  emptyDisplayText?: string
  loadingPanelTooltipText?: Partial<Record<NodePingMetric, string>>
  emptyPanelTooltipText?: Partial<Record<NodePingMetric, string>>
}

function getLatencyToneClass(latency: number): string {
  if (latency <= 60)
    return 'bg-emerald-600/90'
  if (latency <= 120)
    return 'bg-green-500/80'
  if (latency <= 180)
    return 'bg-lime-400/80'
  if (latency <= 240)
    return 'bg-yellow-400/80'
  return 'bg-rose-500/80'
}

function getLossToneClass(loss: number): string {
  if (loss <= 1)
    return 'bg-emerald-600/90'
  if (loss <= 3)
    return 'bg-green-500/80'
  if (loss <= 6)
    return 'bg-lime-400/80'
  if (loss <= 9)
    return 'bg-yellow-400/80'
  return 'bg-rose-500/80'
}

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  options: UseNodePingDisplayOptions = {},
) {
  // Home-card samples are appended by the shared subscribe=all WebSocket.
  const pingStatsEnabled = computed(() => options.enabled === undefined || toValue(options.enabled))
  const nodesStore = useNodesStore()

  const pingStats = useNodePingStats(uuid, {
    enabled: pingStatsEnabled,
    line: options.line,
  })

  /**
   * 将最近两小时数据按时间划分为 NODE_PING_BAR_COUNT 根柱子，
   * 每根柱按段内采样覆盖时长加权。
   */
  function buildPingBars(metric: NodePingMetric): NodePingBar[] {
    const points = pingStats.history.value
    if (!points.length)
      return []

    const perLine = !!toValue(options.line)
    const barCount = perLine ? NODE_PING_BAR_COUNT : Math.min(NODE_PING_BAR_COUNT, points.length)
    const lastTime = perLine ? Math.max(nodesStore.pingNow.getTime(), points.at(-1)!.timeMs) : points.at(-1)!.timeMs
    const firstTime = perLine ? lastTime - PING_HISTORY_WINDOW_MS : points[0]!.timeMs
    const segmentSize = Math.max(1, (lastTime - firstTime) / barCount)

    const bars: NodePingBar[] = []
    // Store histories are sorted: consume each sample once instead of rescanning for every bar.
    let pointIndex = 0
    for (let index = 0; index < barCount; index++) {
      const segmentStart = firstTime + index * segmentSize
      const segmentEnd = index === barCount - 1 ? lastTime + 1 : segmentStart + segmentSize
      const segmentPoints = []
      while (pointIndex < points.length) {
        const point = points[pointIndex]!
        const time = point.timeMs
        if (time >= segmentEnd)
          break
        if (time >= segmentStart)
          segmentPoints.push(point)
        pointIndex++
      }

      const value = pingAverage(segmentPoints, metric, segmentEnd, nodesStore.pingSampleIntervalMs)
      const segmentTime = new Date(segmentStart).toISOString()
      const timeRange = `${formatDateTime(segmentTime, 'HH:mm')} - ${formatDateTime(new Date(segmentEnd).toISOString(), 'HH:mm')}`

      bars.push({
        key: `${metric}-${index}`,
        className: value === null
          ? 'bg-muted-foreground/15'
          : metric === 'latency'
            ? getLatencyToneClass(value)
            : getLossToneClass(value),
        tooltip: `${timeRange} · ${value === null ? 'N/A' : metric === 'latency' ? `${Math.round(value)} ms` : `${Number(value.toFixed(1))}%`}`,
      })
    }

    return bars
  }

  function buildEmptyPingBars(metric: NodePingMetric): NodePingBar[] {
    const tooltip = pingStats.loading.value
      ? '加载中'
      : pingStats.error.value
        ? '加载失败'
        : !pingStatsEnabled.value
            ? '未启用记录'
            : metric === 'latency'
              ? 'N/A'
              : 'N/A'

    return Array.from({ length: NODE_PING_BAR_COUNT }, (_, index) => ({
      key: `${metric}-empty-${index}`,
      className: 'bg-muted-foreground/10',
      tooltip,
    }))
  }

  const latencyBars = computed(() => buildPingBars('latency'))
  const lossBars = computed(() => buildPingBars('loss'))
  const latencyRenderBars = computed(() => latencyBars.value.length ? latencyBars.value : buildEmptyPingBars('latency'))
  const lossRenderBars = computed(() => lossBars.value.length ? lossBars.value : buildEmptyPingBars('loss'))

  const latestLatency = computed(() => {
    const line = toValue(options.line)
    const latest = line ? nodesStore.nodesByUuid.get(toValue(uuid))?.ping?.[line] : undefined
    return latest && Number.isFinite(latest.latest) && latest.latest >= 0 && latest.loss !== 100
      ? latest.latest
      : pingStats.history.value.filter(point => point.latency !== null).at(-1)?.latency ?? null
  })

  const latencyDisplay = computed(() => {
    if (toValue(options.line))
      return latestLatency.value !== null ? `${Math.round(latestLatency.value)} ms` : '--'
    if (pingStats.hasData.value)
      return `${Math.round(pingStats.avgLatency.value)} ms`
    if (pingStats.loading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const lossDisplay = computed(() => {
    if (toValue(options.line) && !pingStats.history.value.some(point => point.loss !== null))
      return '--'
    if (pingStats.hasData.value)
      return `${pingStats.avgLoss.value.toFixed(1)}%`
    if (pingStats.loading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const latencyPanelTooltip = computed(() => {
    if (toValue(options.line))
      return '最新延迟'
    if (!pingStats.hasData.value) {
      if (pingStats.loading.value)
        return options.loadingPanelTooltipText?.latency ?? ''
      return options.emptyPanelTooltipText?.latency ?? ''
    }
    return `平均延迟 ${Math.round(pingStats.avgLatency.value)} ms`
  })

  const lossPanelTooltip = computed(() => {
    if (toValue(options.line))
      return '平均丢包'
    if (!pingStats.hasData.value) {
      if (pingStats.loading.value)
        return options.loadingPanelTooltipText?.loss ?? ''
      return options.emptyPanelTooltipText?.loss ?? ''
    }

    const volatility = pingStats.avgVolatility.value > 0
      ? `，平均波动 ${pingStats.avgVolatility.value.toFixed(2)}`
      : ''
    return `平均丢包 ${pingStats.avgLoss.value.toFixed(1)}%${volatility}`
  })

  return {
    pingStats,
    pingStatsEnabled,
    latencyRenderBars,
    lossRenderBars,
    latestLatency,
    latencyDisplay,
    lossDisplay,
    latencyPanelTooltip,
    lossPanelTooltip,
  }
}
