import type { MaybeRefOrGetter } from 'vue'
import type { PingHistoryPoint } from '@/stores/nodes'
import type { PingLinePoint } from '@/utils/rpc'
import { computed, toValue } from 'vue'
import { useNodesStore } from '@/stores/nodes'

export interface NodePingHistoryPoint extends PingHistoryPoint, PingLinePoint {
  /** Last actual sample in a run of equal values; raw samples remain in the store. */
  endTimeMs?: number
}

export interface PingLatencySummary {
  value: number | null
  timedOut: boolean
}

const MIN_PING_HOLD_MS = 5 * 60_000

/** 单点最大延续时长：允许正常抖动与 5 分钟在线窗口，但不再把断档涂抹多根柱子。 */
function pingMaxHoldMs(stepMs: number): number {
  return Math.max(Math.round(stepMs * 1.5), MIN_PING_HOLD_MS)
}

function pointCoverageWeight(points: NodePingHistoryPoint[], index: number, now: number, maxHold: number, start: number): number {
  const point = points[index]!
  const time = point.timeMs
  const end = Math.min(points[index + 1]?.timeMs ?? now, now, (point.endTimeMs ?? time) + maxHold)
  return Math.max(0, end - Math.max(time, start))
}

/** 按区间内的采样覆盖时长加权，断档最多延续一个半后端采样间隔（下限 5 分钟）。 */
export function pingAverage(points: NodePingHistoryPoint[], metric: 'latency' | 'loss', now: number, stepMs: number, start = Number.NEGATIVE_INFINITY): number | null {
  let total = 0
  let weights = 0
  const maxHold = pingMaxHoldMs(stepMs)
  points.forEach((point, index) => {
    const value = point[metric]
    if (value === null || !Number.isFinite(value))
      return
    const weight = pointCoverageWeight(points, index, now, maxHold, start)
    total += value * weight
    weights += weight
  })
  return weights
    ? total / weights
    : null
}

/** 计算单个柱子区间的延迟均值，并区分“100% 丢包超时”与“无数据”。 */
export function pingLatencySummary(points: NodePingHistoryPoint[], now: number, stepMs: number, start = Number.NEGATIVE_INFINITY): PingLatencySummary {
  let total = 0
  let validWeight = 0
  let timeoutWeight = 0
  const maxHold = pingMaxHoldMs(stepMs)

  points.forEach((point, index) => {
    const weight = pointCoverageWeight(points, index, now, maxHold, start)
    if (weight <= 0)
      return
    const latency = point.latency
    if (latency !== null && Number.isFinite(latency)) {
      total += latency * weight
      validWeight += weight
    }
    else if (point.timedOut || point.loss === 100) {
      timeoutWeight += weight
    }
  })

  // 当柱内半数及以上有效覆盖时间处于 100% 丢包超时，按超时展示，避免被前一个正常桶的尾段“洗白”。
  if (timeoutWeight > 0 && timeoutWeight >= validWeight)
    return { value: null, timedOut: true }

  if (validWeight > 0)
    return { value: total / validWeight, timedOut: false }

  return { value: null, timedOut: false }
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  line: MaybeRefOrGetter<string>,
) {
  const nodesStore = useNodesStore()
  const history = computed(() => {
    const lineKey = toValue(line)
    const maxGap = pingMaxHoldMs(nodesStore.pingSampleIntervalMs)
    const points: NodePingHistoryPoint[] = []
    let previous: NodePingHistoryPoint | undefined
    for (const point of nodesStore.pingHistoryByUuid[toValue(uuid)] ?? []) {
      const values = point.lines?.[lineKey]
      if (!values)
        continue
      // Merge only continuous equal coverage, preserving gaps and exact interval weights.
      if (previous && previous.latency === values.latency && previous.loss === values.loss
        && Boolean(previous.timedOut) === Boolean(values.timedOut)
        && point.timeMs - (previous.endTimeMs ?? previous.timeMs) <= maxGap) {
        previous.endTimeMs = point.timeMs
      }
      else {
        previous = {
          time: point.time,
          timeMs: point.timeMs,
          latency: values.latency,
          loss: values.loss,
          ...(values.timedOut
            ? { timedOut: true }
            : {}),
        }
        points.push(previous)
      }
    }
    return points
  })

  const avgLoss = computed(() => {
    // Same window end as the history bars, including samples from the last millisecond.
    const last = history.value.at(-1)
    const now = Math.max(nodesStore.pingNow.getTime(), last?.endTimeMs ?? last?.timeMs ?? 0) + 1
    return pingAverage(history.value, 'loss', now, nodesStore.pingSampleIntervalMs, now - 1 - nodesStore.pingHistoryWindowMs)
  })

  return { history, avgLoss }
}
