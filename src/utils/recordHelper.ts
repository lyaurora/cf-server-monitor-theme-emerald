/**
 * 数据处理工具函数
 * 参考 React 版本的 RecordHelper.tsx 实现
 */

/** 负载记录格式 */
export interface RecordFormat {
  client: string
  time: string
  cpu: number | null
  gpu: number | null
  ram: number | null
  ram_total: number | null
  swap: number | null
  swap_total: number | null
  load: number | null
  temp: number | null
  disk: number | null
  disk_total: number | null
  net_in: number | null
  net_out: number | null
  net_total_up: number | null
  net_total_down: number | null
  process: number | null
  connections: number | null
  connections_udp: number | null
}

type AnyRecord = Record<string, any>

/**
 * EWMA（指数加权移动平均）峰值裁剪
 * 使用指数加权移动平均算法平滑数据，同时检测并过滤突变值，填充 null/undefined 值
 *
 * @param data 输入数据数组
 * @param keys 需要处理的数值属性名数组
 * @param alpha 平滑因子
 * @param windowSize 突变检测窗口大小
 * @param spikeThreshold 突变阈值
 */
export function cutPeakValues(
  data: AnyRecord[],
  keys: string[],
  alpha: number = 0.3,
  windowSize: number = 15,
  spikeThreshold: number = 0.3,
): AnyRecord[] {
  if (!data || data.length === 0)
    return data

  const result: AnyRecord[] = [...data]
  const halfWindow = Math.floor(windowSize / 2)

  for (const key of keys) {
    // 第一步：基于原始值检测突变，再统一置空，避免已置空的尖峰影响后续检测
    const spikes: number[] = []
    for (let i = 0; i < result.length; i++) {
      const currentRow = result[i]
      if (!currentRow)
        continue
      const currentValue = currentRow[key]

      if (currentValue != null && typeof currentValue === 'number') {
        const neighborValues: number[] = []

        // 收集窗口范围内的邻近有效值
        for (
          let j = Math.max(0, i - halfWindow);
          j <= Math.min(result.length - 1, i + halfWindow);
          j++
        ) {
          if (j === i)
            continue
          const neighborRow = result[j]
          if (!neighborRow)
            continue
          const neighbor = neighborRow[key]
          if (neighbor != null && typeof neighbor === 'number') {
            neighborValues.push(neighbor)
          }
        }

        // 如果有足够的邻近值进行突变检测
        if (neighborValues.length >= 2) {
          const neighborSum = neighborValues.reduce((sum, val) => sum + val, 0)
          const neighborMean = neighborSum / neighborValues.length

          // 检测突变
          if (neighborMean > 0) {
            const relativeChange = Math.abs(currentValue - neighborMean) / neighborMean
            if (relativeChange > spikeThreshold)
              spikes.push(i)
          }
          else if (Math.abs(currentValue) > 10) {
            spikes.push(i)
          }
        }
      }
    }
    for (const i of spikes)
      result[i] = { ...result[i], [key]: null }

    // 第二步：使用 EWMA 平滑和填充
    let ewma: number | null = null

    for (let i = 0; i < result.length; i++) {
      const row = result[i]
      if (!row)
        continue
      const currentValue = row[key]

      if (currentValue != null && typeof currentValue === 'number') {
        if (ewma === null) {
          ewma = currentValue
        }
        else {
          ewma = alpha * currentValue + (1 - alpha) * ewma
        }
        result[i] = { ...row, [key]: ewma }
      }
      else if (ewma !== null) {
        result[i] = { ...row, [key]: ewma }
      }
    }
  }

  return result
}
