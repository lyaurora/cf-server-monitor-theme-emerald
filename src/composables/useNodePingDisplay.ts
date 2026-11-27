import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'
import { pingAverage, pingLatencySummary, useNodePingStats } from '@/composables/useNodePingStats'
import { useNodesStore } from '@/stores/nodes'

export type NodePingMetric = 'latency' | 'loss'

export interface NodePingBar {
  key: string
  className: string
  tooltip: string
}

function formatBarTime(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
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

const emptyBarsCache = new Map<string, NodePingBar[]>()

function getEmptyPingBars(metric: NodePingMetric, count: number): NodePingBar[] {
  const cacheKey = `${metric}:${count}`
  const cached = emptyBarsCache.get(cacheKey)
  if (cached)
    return cached
  const bars = Array.from({ length: count }, (_, index) => ({
    key: `${metric}-empty-${index}`,
    className: 'bg-muted-foreground/10',
    tooltip: 'N/A',
  }))
  emptyBarsCache.set(cacheKey, bars)
  return bars
}

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  line: MaybeRefOrGetter<string>,
) {
  // Home-card samples are appended by the shared subscribe=all WebSocket.
  const nodesStore = useNodesStore()
  const { history, avgLoss } = useNodePingStats(uuid, line)

  /**
   * 将窗口内数据按时间划分为 pingHistoryBarCount 根柱子，
   * 每根柱按段内采样覆盖时长加权。
   */
  function buildPingBars(metric: NodePingMetric, previous?: NodePingBar[]): NodePingBar[] {
    const points = history.value
    if (!points.length)
      return []

    const barCount = nodesStore.pingHistoryBarCount
    const latestTime = points.at(-1)!.endTimeMs ?? points.at(-1)!.timeMs
    const lastTime = Math.max(nodesStore.pingNow.getTime(), latestTime)
    const firstTime = lastTime - nodesStore.pingHistoryWindowMs
    const segmentSize = Math.max(1, (lastTime - firstTime) / barCount)

    const bars: NodePingBar[] = []
    // Store histories are sorted: consume each sample once instead of rescanning for every bar.
    let pointIndex = 0
    for (let index = 0; index < barCount; index++) {
      const segmentStart = firstTime + index * segmentSize
      const segmentEnd = index === barCount - 1
        ? lastTime + 1
        : segmentStart + segmentSize
      // The preceding sample may still cover the beginning of this segment.
      const segmentPoints = pointIndex > 0
        ? [points[pointIndex - 1]!]
        : []
      while (pointIndex < points.length) {
        const point = points[pointIndex]!
        const time = point.timeMs
        if (time >= segmentEnd)
          break
        segmentPoints.push(point)
        pointIndex++
      }

      const timeRange = `${formatBarTime(segmentStart)} - ${formatBarTime(segmentEnd)}`
      if (metric === 'latency') {
        const summary = pingLatencySummary(segmentPoints, segmentEnd, nodesStore.pingSampleIntervalMs, segmentStart)
        bars.push({
          key: `${metric}-${index}`,
          className: summary.timedOut
            ? 'bg-rose-500/80'
            : summary.value === null
              ? 'bg-muted-foreground/15'
              : getLatencyToneClass(summary.value),
          tooltip: `${timeRange} · ${summary.timedOut
            ? '超时'
            : summary.value === null
              ? 'N/A'
              : `${Math.round(summary.value)} ms`}`,
        })
      }
      else {
        const value = pingAverage(segmentPoints, 'loss', segmentEnd, nodesStore.pingSampleIntervalMs, segmentStart)
        bars.push({
          key: `${metric}-${index}`,
          className: value === null
            ? 'bg-muted-foreground/15'
            : getLossToneClass(value),
          tooltip: `${timeRange} · ${value === null
            ? 'N/A'
            : `${Number(value.toFixed(1))}%`}`,
        })
      }
    }

    // New samples can leave every displayed value unchanged; avoid invalidating the row in that case.
    if (previous?.length === bars.length && bars.every((bar, index) => {
      const old = previous[index]!
      return bar.key === old.key && bar.className === old.className && bar.tooltip === old.tooltip
    })) {
      return previous
    }
    return bars
  }

  const latencyBars = computed<NodePingBar[]>(previous => buildPingBars('latency', previous))
  const lossBars = computed<NodePingBar[]>(previous => buildPingBars('loss', previous))
  const latencyRenderBars = computed(() => latencyBars.value.length
    ? latencyBars.value
    : getEmptyPingBars('latency', nodesStore.pingHistoryBarCount))
  const lossRenderBars = computed(() => lossBars.value.length
    ? lossBars.value
    : getEmptyPingBars('loss', nodesStore.pingHistoryBarCount))

  const latestPing = computed(() => nodesStore.nodesByUuid.get(toValue(uuid))?.ping?.[toValue(line)])
  const latestLatency = computed(() => {
    const latest = latestPing.value
    return latest && Number.isFinite(latest.latest) && latest.latest >= 0 && latest.loss !== 100
      ? latest.latest
      : null
  })

  const latencyDisplay = computed(() => {
    const latest = latestPing.value
    if (latest && (latest.latest < 0 || latest.loss === 100))
      return '超时'
    return latestLatency.value !== null
      ? `${Math.round(latestLatency.value)} ms`
      : '--'
  })

  const lossDisplay = computed(() => avgLoss.value === null
    ? '--'
    : `${avgLoss.value.toFixed(1)}%`)

  return {
    latencyRenderBars,
    lossRenderBars,
    latestLatency,
    latencyDisplay,
    lossDisplay,
    latencyPanelTooltip: '最新延迟',
    lossPanelTooltip: '平均丢包',
  }
}
