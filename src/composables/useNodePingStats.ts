import type { MaybeRefOrGetter } from 'vue'
import type { PingHistoryPoint } from '@/stores/nodes'
import type { PingLinePoint } from '@/utils/rpc'
import { computed, toValue } from 'vue'
import { PING_HISTORY_WINDOW_MS, useNodesStore } from '@/stores/nodes'

export interface NodePingHistoryPoint extends PingHistoryPoint, PingLinePoint {
  /** Last actual sample in a run of equal values; raw samples remain in the store. */
  endTimeMs?: number
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
  line: MaybeRefOrGetter<string>,
) {
  const nodesStore = useNodesStore()
  const history = computed(() => {
    const lineKey = toValue(line)
    const maxGap = nodesStore.pingSampleIntervalMs * 4
    const points: NodePingHistoryPoint[] = []
    let previous: NodePingHistoryPoint | undefined
    for (const point of nodesStore.pingHistoryByUuid[toValue(uuid)] ?? []) {
      const values = point.lines?.[lineKey]
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

  const avgLoss = computed(() => {
    // Same window end as the history bars, including samples from the last millisecond.
    const last = history.value.at(-1)
    const now = Math.max(nodesStore.pingNow.getTime(), last?.endTimeMs ?? last?.timeMs ?? 0) + 1
    return pingAverage(history.value, 'loss', now, nodesStore.pingSampleIntervalMs, now - 1 - PING_HISTORY_WINDOW_MS)
  })

  return { history, avgLoss }
}
