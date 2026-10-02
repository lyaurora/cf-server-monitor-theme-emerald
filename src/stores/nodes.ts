import type { Client, NodeStatus, PingSample, PingWindowPoint } from '@/utils/rpc'
import { useNow } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowReactive } from 'vue'
import { parseNodeGroups } from '@/utils/groupHelper'

export interface PingHistoryPoint extends PingWindowPoint {
  /** Parse once on ingestion; all history calculations use milliseconds. */
  timeMs: number
}

export const PING_HISTORY_WINDOW_MS = 2 * 3_600_000

/** 节点完整信息（合并 Client 和 Status） */
export interface NodeData extends Client, StatusData {
  pingSample?: PingSample
}

/** 状态数据（用于更新） */
interface StatusData extends Omit<NodeStatus, 'client' | 'ram_total' | 'pingWindow'> {
  mem_total: number
}

const EARTH_SNAPSHOT_INTERVAL_MS = 60_000

/** 首页 ping/loss 历史摄取配置（由后端 /api/config 与 /api/servers 下发，缺省时回退旧行为） */
interface PingHistoryConfig {
  /** 后端 show_three_net_details：是否显示/消费三网延迟丢包详情（false 时卡片/列表隐藏相应信息） */
  showThreeNetDetails: boolean
  /** latency_window.points：保留的桶数 */
  points: number
  /** latency_window.hours：窗口时长（小时），桶长 = hours / points */
  hours: number
}

const PING_HISTORY_DEFAULTS: PingHistoryConfig = {
  // 缺省按两小时、两分钟粒度显示；旧后端缺失的历史保持为空。
  showThreeNetDetails: true,
  points: 60,
  hours: 2,
}

const useNodesStore = defineStore('nodes', () => {
  // ===== 状态 =====
  const nodes = ref<NodeData[]>([])
  const earthNodes = ref<NodeData[]>([])
  // Histories are replaced as snapshots; only track each node's array, not every sample field.
  const pingHistoryByUuid = shallowReactive<Record<string, PingHistoryPoint[]>>(Object.create(null))
  const pingNow = useNow({ interval: 60_000 })
  const pageLoading = ref(false)
  const pingHistoryConfig = ref<PingHistoryConfig>({ ...PING_HISTORY_DEFAULTS })
  let lastEarthSnapshotAt = 0

  // ===== 计算属性 =====
  /** 所有分组 */
  const groups = computed(() => {
    const groupSet = new Set<string>()
    nodes.value.forEach((n) => {
      parseNodeGroups(n.group).forEach(group => groupSet.add(group))
    })
    return Array.from(groupSet)
  })

  /** 按 UUID 索引的节点映射 */
  const nodesByUuid = computed(() => {
    const map = new Map<string, NodeData>()
    nodes.value.forEach((n) => {
      map.set(n.uuid, n)
    })
    return map
  })

  /** 后端 show_three_net_details：false 时卡片/列表隐藏三网延迟丢包信息 */
  const showThreeNetDetails = computed(() => pingHistoryConfig.value.showThreeNetDetails)
  const pingSampleIntervalMs = computed(() => pingHistoryBucketMs())

  // ===== 方法 =====

  /**
   * 从 Client 对象创建节点数据
   */
  function createNodeFromClient(client: Client): NodeData {
    return {
      ...client,
      // Status 默认值
      online: false,
      time: '',
      cpu: 0,
      gpu: 0,
      ram: 0,
      swap: null,
      load: 0,
      load5: 0,
      load15: 0,
      temp: 0,
      disk: 0,
      net_in: 0,
      net_out: 0,
      net_total_up: 0,
      net_total_down: 0,
      net_monthly_up: 0,
      net_monthly_down: 0,
      process: 0,
      connections: 0,
      connections_udp: 0,
      uptime: 0,
      ping: undefined,
    }
  }

  /**
   * 从 NodeStatus 提取状态数据
   */
  function extractStatusData(status: NodeStatus): StatusData {
    return {
      mem_total: status.ram_total,
      disk_total: status.disk_total,
      online: status.online,
      time: status.time,
      cpu: status.cpu,
      gpu: status.gpu,
      ram: status.ram,
      swap: status.swap,
      swap_total: status.swap_total,
      load: status.load,
      load5: status.load5,
      load15: status.load15,
      temp: status.temp,
      disk: status.disk,
      net_in: status.net_in,
      net_out: status.net_out,
      net_total_up: status.net_total_up,
      net_total_down: status.net_total_down,
      net_monthly_up: status.net_monthly_up,
      net_monthly_down: status.net_monthly_down,
      process: status.process,
      connections: status.connections,
      connections_udp: status.connections_udp,
      uptime: status.uptime,
      ping: status.ping,
    }
  }

  /** 当前配置下的窗口桶长（毫秒）；points/hours 无效时回退默认值 */
  function pingHistoryBucketMs(): number {
    const { points, hours } = pingHistoryConfig.value
    return Math.max(1, Math.round(hours * 3_600_000 / points))
  }

  /**
   * 按后端配置调整 ping 历史摄取策略：showThreeNetDetails 决定是否消费窗口，points/hours 决定桶长与保留条数。
   * 缺省字段保持默认值（兼容旧后端）。
   */
  function configurePingHistory(config: Partial<PingHistoryConfig>): void {
    const points = Number.isFinite(config.points) && (config.points ?? 0) > 0
      ? Math.round(config.points!)
      : pingHistoryConfig.value.points
    const hours = Number.isFinite(config.hours) && (config.hours ?? 0) > 0
      ? config.hours!
      : pingHistoryConfig.value.hours
    pingHistoryConfig.value = {
      showThreeNetDetails: config.showThreeNetDetails ?? pingHistoryConfig.value.showThreeNetDetails,
      points,
      hours,
    }
  }

  /** 保留真实采样时间，避免把一分钟实测与数分钟窗口桶等权混算。 */
  function recordPingSample(uuid: string, status: NodeStatus): void {
    const sampleTime = Date.parse(status.time)
    if (!Number.isFinite(sampleTime) || sampleTime < Date.now() - PING_HISTORY_WINDOW_MS - pingHistoryBucketMs() * 4)
      return
    const entries = Object.entries(status.ping ?? {}).filter(([, entry]) => Number.isFinite(entry.latest) || Number.isFinite(entry.loss))
    if (!entries.length)
      return
    const node = nodesByUuid.value.get(uuid)
    // This feeds chart samples, including replay; current node state is guarded separately.
    if (node)
      node.pingSample = { time: status.time, ping: Object.fromEntries(entries) }
    const history = pingHistoryByUuid[uuid] ?? []
    const append = !history.length || sampleTime > history.at(-1)!.timeMs
    const lines = { ...(append ? undefined : history.find(item => item.time === status.time)?.lines) }
    for (const [key, entry] of entries) {
      const previous = lines[key]
      const latency = Number.isFinite(entry.latest)
        ? entry.latest >= 0 ? entry.latest : null
        : previous?.latency ?? null
      const loss = Number.isFinite(entry.loss)
        ? entry.loss >= 0 && entry.loss <= 100 ? entry.loss : null
        : previous?.loss ?? null
      lines[key] = { latency: loss === 100 ? null : latency, loss }
    }
    const point = { time: status.time, timeMs: sampleTime, lines }
    const cutoff = Date.now() - PING_HISTORY_WINDOW_MS - pingHistoryBucketMs() * 4
    if (append) {
      let start = 0
      while (start < history.length && history[start]!.timeMs < cutoff)
        start++
      const next = history.slice(start)
      next.push(point)
      pingHistoryByUuid[uuid] = next
      return
    }
    // ponytail: bounded two-hour array; use a ring buffer if very large fleets make insertion costly.
    pingHistoryByUuid[uuid] = [...history.filter(item => item.time !== point.time && item.timeMs >= cutoff), point]
      .sort((a, b) => a.timeMs - b.timeMs)
  }

  /**
   * Earth 视图共享采样快照，避免 globe / maps 各自维护定时器。
   */
  function refreshEarthNodes(force = false): void {
    const now = Date.now()
    if (!force && now - lastEarthSnapshotAt < EARTH_SNAPSHOT_INTERVAL_MS)
      return

    // Resource updates mutate nodes; keep the globe's snapshot until its next refresh.
    earthNodes.value = nodes.value.map(node => ({ ...node }))
    lastEarthSnapshotAt = now
  }

  /** CFSM uses a fixed five-minute reporting deadline, even when no new packet arrives. */
  function refreshOnlineState(now = Date.now()): void {
    let changed = false
    for (const node of nodes.value) {
      const lastReport = Date.parse(node.time)
      const online = Number.isFinite(lastReport) && now - lastReport < 300_000
      if (node.online !== online) {
        node.online = online
        changed = true
      }
    }
    if (changed)
      refreshEarthNodes(true)
  }

  /**
   * 初始化节点数据（首次加载）
   */
  function initNodes(clients: Record<string, Client>, statuses: Record<string, NodeStatus>, replace = true): void {
    const uuids = Object.keys(clients)

    // 更新现有节点或添加新节点
    uuids.forEach((uuid) => {
      const client = clients[uuid]
      if (!client)
        return

      const status = statuses[uuid]
      const index = nodes.value.findIndex(n => n.uuid === uuid)

      const node = {
        ...createNodeFromClient(client),
        ...(status ? extractStatusData(status) : {}),
      }
      if (index !== -1)
        nodes.value[index] = node
      else
        nodes.value.push(node)

      if (status) {
        // 开关开启且后端返回窗口时直接作为历史（已含最新桶），
        // 否则（开关关闭 / 窗口缺失）由实时样本按单条 ping 值逐步累积
        if (pingHistoryConfig.value.showThreeNetDetails && status.pingWindow?.length) {
          const cutoff = Date.now() - PING_HISTORY_WINDOW_MS - pingHistoryBucketMs() * 4
          pingHistoryByUuid[uuid] = status.pingWindow
            .map(point => ({ ...point, timeMs: Date.parse(point.time) }))
            .filter(point => point.timeMs >= cutoff)
        }
        recordPingSample(uuid, status)
      }
    })

    // 移除不存在的节点
    const newUuids = new Set(uuids)
    for (let i = nodes.value.length - 1; i >= 0; i--) {
      const node = nodes.value[i]
      if (replace && node && !newUuids.has(node.uuid)) {
        delete pingHistoryByUuid[node.uuid]
        nodes.value.splice(i, 1)
      }
    }

    // 按 weight 升序排序（weight 越小越靠前）
    sortNodesByWeight()
    refreshEarthNodes(true)
  }

  /**
   * 按 weight 升序排序节点（weight 越小越靠前）
   */
  function sortNodesByWeight(): void {
    nodes.value.sort((a, b) => a.weight - b.weight)
  }

  /**
   * 更新节点状态（实时更新）
   */
  function updateNodeStatuses(statuses: Record<string, NodeStatus>): void {
    let hasChanges = false

    nodes.value.forEach((node) => {
      if (!Object.hasOwn(statuses, node.uuid))
        return

      const status = statuses[node.uuid]
      if (!status)
        return

      // Preserve node identity so resource ticks do not invalidate filtered lists.
      Object.assign(node, extractStatusData(status))
      hasChanges = true
    })

    if (hasChanges)
      refreshEarthNodes()
  }

  /**
   * 清空所有节点数据
   */
  function clearNodes(): void {
    nodes.value = []
    for (const uuid of Object.keys(pingHistoryByUuid))
      delete pingHistoryByUuid[uuid]
    refreshEarthNodes(true)
  }

  return {
    // 状态
    nodes,
    earthNodes,
    pingHistoryByUuid,
    pingNow,
    pingSampleIntervalMs,
    pageLoading,
    // 计算属性
    groups,
    nodesByUuid,
    showThreeNetDetails,
    // 方法
    initNodes,
    updateNodeStatuses,
    refreshOnlineState,
    recordPingSample,
    configurePingHistory,
    sortNodesByWeight,
    clearNodes,
  }
})

export { useNodesStore }
