import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'
import { NODE_PING_BAR_COUNT, pingAverage, useNodePingStats } from '@/composables/useNodePingStats'
import { PING_HISTORY_WINDOW_MS, useNodesStore } from '@/stores/nodes'

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

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  line: MaybeRefOrGetter<string>,
) {
  // Home-card samples are appended by the shared subscribe=all WebSocket.
  const nodesStore = useNodesStore()
  const { history, avgLoss } = useNodePingStats(uuid, line)

  /**
   * 将最近两小时数据按时间划分为 NODE_PING_BAR_COUNT 根柱子，
   * 每根柱按段内采样覆盖时长加权。
   */
  function buildPingBars(metric: NodePingMetric, previous?: NodePingBar[]): NodePingBar[] {
    const points = history.value
    if (!points.length)
      return []

    const barCount = NODE_PING_BAR_COUNT
    const latestTime = points.at(-1)!.endTimeMs ?? points.at(-1)!.timeMs
    const lastTime = Math.max(nodesStore.pingNow.getTime(), latestTime)
    const firstTime = lastTime - PING_HISTORY_WINDOW_MS
    const segmentSize = Math.max(1, (lastTime - firstTime) / barCount)

    const bars: NodePingBar[] = []
    // Store histories are sorted: consume each sample once instead of rescanning for every bar.
    let pointIndex = 0
    for (let index = 0; index < barCount; index++) {
      const segmentStart = firstTime + index * segmentSize
      const segmentEnd = index === barCount - 1 ? lastTime + 1 : segmentStart + segmentSize
      // The preceding sample may still cover the beginning of this segment.
      const segmentPoints = pointIndex > 0 ? [points[pointIndex - 1]!] : []
      while (pointIndex < points.length) {
        const point = points[pointIndex]!
        const time = point.timeMs
        if (time >= segmentEnd)
          break
        segmentPoints.push(point)
        pointIndex++
      }

      const value = pingAverage(segmentPoints, metric, segmentEnd, nodesStore.pingSampleIntervalMs, segmentStart)
      const timeRange = `${formatBarTime(segmentStart)} - ${formatBarTime(segmentEnd)}`

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

    // New samples can leave every displayed value unchanged; avoid invalidating the row in that case.
    if (previous?.length === bars.length && bars.every((bar, index) => {
      const old = previous[index]!
      return bar.key === old.key && bar.className === old.className && bar.tooltip === old.tooltip
    })) {
      return previous
    }
    return bars
  }

  function buildEmptyPingBars(metric: NodePingMetric): NodePingBar[] {
    return Array.from({ length: NODE_PING_BAR_COUNT }, (_, index) => ({
      key: `${metric}-empty-${index}`,
      className: 'bg-muted-foreground/10',
      tooltip: 'N/A',
    }))
  }

  const latencyBars = computed<NodePingBar[]>(previous => buildPingBars('latency', previous))
  const lossBars = computed<NodePingBar[]>(previous => buildPingBars('loss', previous))
  const latencyRenderBars = computed(() => latencyBars.value.length ? latencyBars.value : buildEmptyPingBars('latency'))
  const lossRenderBars = computed(() => lossBars.value.length ? lossBars.value : buildEmptyPingBars('loss'))

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
    return latestLatency.value !== null ? `${Math.round(latestLatency.value)} ms` : '--'
  })

  const lossDisplay = computed(() => avgLoss.value === null ? '--' : `${avgLoss.value.toFixed(1)}%`)

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
