import type { MaybeRefOrGetter } from 'vue'
import type { PingHistoryPoint } from '@/stores/nodes'
import { computed, ref, toValue } from 'vue'
import { PING_HISTORY_WINDOW_MS, useNodesStore } from '@/stores/nodes'

export interface NodePingHistoryPoint extends PingHistoryPoint {}

export interface NodePingStatsState {
  avgLatency: number
  avgLoss: number
  avgVolatility: number
  history: NodePingHistoryPoint[]
  hasData: boolean
}

export const NODE_PING_BAR_COUNT = 10

/** 按采样覆盖时长加权，断档最多延续四个后端采样间隔。 */
export function pingAverage(points: PingHistoryPoint[], metric: 'latency' | 'loss', now: number, stepMs: number): number | null {
  let total = 0
  let weights = 0
  points.forEach((point, index) => {
    const value = point[metric]
    if (value === null || !Number.isFinite(value))
      return
    const time = Date.parse(point.time)
    const end = Math.min(Date.parse(points[index + 1]?.time ?? '') || now, now, time + stepMs * 4)
    const weight = Math.max(1, end - time)
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
    const points = (nodesStore.pingHistoryByUuid[toValue(uuid)] ?? [])
      .filter(point => Date.parse(point.time) >= now - PING_HISTORY_WINDOW_MS && Date.parse(point.time) <= Math.max(now, Date.now()))
    const line = toValue(options?.line)
    return line ? points.flatMap(point => point.lines?.[line] ? [{ time: point.time, ...point.lines[line] }] : []) : points
  })

  const stats = computed<NodePingStatsState>(() => {
    const points = history.value
    const now = Date.now()
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
