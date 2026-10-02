/** 流量限制类型 */
export type TrafficLimitType = 'up' | 'down' | 'min' | 'max' | 'sum'

export interface Client {
  uuid: string
  name: string
  cpu_name: string
  kernel_version: string
  arch: string
  cpu_cores: number
  os: string
  boot_time: string
  gpu_name?: string
  gpu_info?: string
  region: string
  mem_total: number
  swap_total: number | null
  disk_total: number
  weight: number
  price: number
  /** Whether the backend supplied a price. False distinguishes an unset value from a free (0/-1) plan. */
  price_configured?: boolean
  billing_cycle: number
  auto_renewal: boolean
  currency: string
  expired_at: string
  group: string
  tags: string
  showPrice: boolean
  showExpire: boolean
  showTraffic: boolean
  traffic_limit: number
  traffic_limit_type: TrafficLimitType
}

export interface NodeStatusPing {
  name: string
  latest: number
  loss: number
}

/** Only probe fields carried by one real sample, before current-state merging. */
export interface PingSample {
  time: string
  ping: Record<string, NodeStatusPing>
}

export interface PingLinePoint {
  latency: number | null
  loss: number | null
}

/** 同一时间点的各线路采样。 */
export interface PingWindowPoint {
  time: string
  lines?: Record<string, PingLinePoint>
}

export interface NodeStatus extends StatusRecord {
  online: boolean
  uptime: number
  ping?: Record<string, NodeStatusPing>
  /** /api/servers 返回的真实采样窗口（旧→新），保留各线路和时间戳。 */
  pingWindow?: PingWindowPoint[]
}

export interface StatusRecord {
  client: string
  time: string
  cpu: number
  gpu: number
  ram: number
  ram_total: number
  swap: number | null
  swap_total: number | null
  load: number
  load5: number
  load15: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  net_total_up: number
  net_total_down: number
  net_monthly_up: number
  net_monthly_down: number
  process: number
  connections: number
  connections_udp: number
}

export interface PingRecord {
  client: string
  task_id: number
  time: string
  value: number
  loss?: number
}
