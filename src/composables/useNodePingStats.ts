import type { MaybeRefOrGetter } from 'vue'
import type { PingHistoryPoint } from '@/stores/nodes'
import { computed, ref, toValue } from 'vue'
import { PING_HISTORY_WINDOW_MS, useNodesStore } from '@/stores/nodes'

export interface NodePingHistoryPoint extends PingHistoryPoint {
  /** Last actual sample in a run of equal values; raw samples remain in the store. */
  endTimeMs?: number
}

export interface NodePingStatsState {
  avgLatency: number
  avgLoss: number
  avgVolatility: number
  history: NodePingHistoryPoint[]
  hasData: boolean
}

export const NODE_PING_BAR_COUNT = 20

/** 按区间内的采样覆盖时长加权，断档最多延续四个后端采样间隔。 */
export function pingAverage(points: NodePingHistoryPoint[], metric: 'latency' | 'loss', now: number, stepMs: number, start = Number.NEGATIVE_INFINITY): number | null {
  let total = 0
  let weights = 0
  points.forEach((point, index) => {
    const value = point[metric]
    if (value === null || !Number.isFinite(value))
      return
    const time = point.timeMs
    const end = Math.min(points[index + 1]?.timeMs ?? now, now, (point.endTimeMs ?? time) + stepMs * 4)
    const weight = Math.max(0, end - Math.max(time, start))
    total += value * weight
    weights += weight
  })
  return weights ? total / weights : null
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: { enabled?: MaybeRefOrGetter<boolean>, line?: MaybeRefOrGetter<string> },
) {
  const nodesStore = useNodesStore()
  const enabled = computed(() => toValue(options?.enabled) ?? true)
  const history = computed(() => {
    if (!enabled.value)
      return []
    const now = nodesStore.pingNow.getTime()
    const cutoff = now - PING_HISTORY_WINDOW_MS
    const latest = Math.max(now, Date.now())
    const line = toValue(options?.line)
    const maxGap = nodesStore.pingSampleIntervalMs * 4
    const points: NodePingHistoryPoint[] = []
    let previous: NodePingHistoryPoint | undefined
    for (const point of nodesStore.pingHistoryByUuid[toValue(uuid)] ?? []) {
      if (!(point.timeMs >= cutoff && point.timeMs <= latest))
        continue
      if (!line) {
        points.push(point)
        continue
      }
      const values = point.lines?.[line]
      if (!values)
        continue
      // Merge only continuous equal coverage, preserving gaps and exact interval weights.
      if (previous && previous.latency === values.latency && previous.loss === values.loss
        && point.timeMs - (previous.endTimeMs ?? previous.timeMs) <= maxGap) {
        previous.endTimeMs = point.timeMs
      }
      else {
        previous = { time: point.time, timeMs: point.timeMs, latency: values.latency, loss: values.loss }
        points.push(previous)
      }
    }
    return points
  })

  const stats = computed<NodePingStatsState>(() => {
    const points = history.value
    // Match the last history bar by including samples from the current millisecond.
    const now = Date.now() + 1
    const avgLatency = pingAverage(points, 'latency', now, nodesStore.pingSampleIntervalMs)
    const avgLoss = pingAverage(points, 'loss', now, nodesStore.pingSampleIntervalMs)

    return {
      avgLatency: avgLatency ?? 0,
      avgLoss: avgLoss ?? 0,
      avgVolatility: 0,
      history: points,
      hasData: avgLatency !== null || avgLoss !== null,
    }
  })

  return {
    stats,
    loading: ref(false),
    error: ref<string | null>(null),
    history,
    avgLatency: computed(() => stats.value.avgLatency),
    avgLoss: computed(() => stats.value.avgLoss),
    avgVolatility: computed(() => stats.value.avgVolatility),
    hasData: computed(() => stats.value.hasData),
  }
}
