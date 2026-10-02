import type { WatchStopHandle } from 'vue'
import type { NodeStatus } from '@/utils/rpc'
import { watch } from 'vue'
import router from '@/router'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import {
  adaptServer,
  ApiError,
  buildAdminUrl,
  cfRequest,
  fetchAllServers,
  fetchServer,
  fetchSiteConfig,
  getPublicSettings,
  invalidateHistoryRequests,
  isEnabledValue,
  mergeServerPingSample,
} from '@/utils/api'
import { requestTurnstileToken } from '@/utils/turnstile'

interface WsMessage {
  type: string
  ts?: number | string
  updates?: Array<{
    serverId: string
    samples?: Array<{
      ts?: number | string
      timestamp?: number | string
      data?: Record<string, unknown>
      payload?: Record<string, unknown>
      metrics?: Record<string, unknown>
    }>
  }>
}

interface LiveSample {
  serverId: string
  ts: number
  data: Record<string, unknown>
}

function normalizeSampleTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value !== 'number' && typeof value !== 'string')
    return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0)
    return fallback
  return number < 1e12 ? number * 1000 : number
}

function sampleHasField(data: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some(key => data[key] !== undefined && data[key] !== null && data[key] !== '')
}

class InitManager {
  private appStore = useAppStore()
  private nodesStore = useNodesStore()
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private liveUpdateTimer: ReturnType<typeof setInterval> | null = null
  private pendingStatuses = new Map<string, NodeStatus>()
  private stopRouteWatch: WatchStopHandle | null = null
  private revision = 0
  private destroyed = false

  private get activeUuid(): string | null {
    const route = router.currentRoute.value
    return route.name === 'instance-detail' ? String(route.params.id) : null
  }

  async init(): Promise<void> {
    try {
      let config = await fetchSiteConfig()
      if (this.destroyed)
        return
      if (isEnabledValue(config.turnstile_enabled) && !config.verified) {
        if (!config.turnstile_site_key)
          throw new Error('源站已启用 Turnstile，但未返回 Site Key')
        const token = await requestTurnstileToken(config.turnstile_site_key)
        if (this.destroyed)
          return
        localStorage.setItem('turnstile_token', token)
        await cfRequest('/api/config')
        if (this.destroyed)
          return
        config = await fetchSiteConfig()
      }
      if (this.destroyed)
        return

      if (config.site_title)
        document.title = config.site_title
      if (!isEnabledValue(config.is_public) && !config.authorization) {
        window.location.href = buildAdminUrl()
        return
      }

      const publicSettings = await getPublicSettings()
      if (this.destroyed)
        return
      this.appStore.publicSettings = publicSettings
      this.appStore.updateLoginState(config.authorization)
      this.nodesStore.configurePingHistory({
        points: config.latency_window?.points,
        hours: config.latency_window?.hours,
      })
      await router.isReady()
      if (this.destroyed)
        return
      this.stopRouteWatch = watch(() => router.currentRoute.value.fullPath, this.reloadPage)
      this.liveUpdateTimer = setInterval(() => {
        this.flushPendingStatuses()
        // A disconnected browser cannot infer outages from its stale snapshot.
        if (this.socket?.readyState === WebSocket.OPEN)
          this.nodesStore.refreshOnlineState()
      }, 1000)
      await this.refreshPage()
    }
    catch (error) {
      if (this.destroyed)
        return
      throw error
    }
    finally {
      if (!this.destroyed)
        this.appStore.loading = false
    }
  }

  private reloadPage = (): void => {
    void this.refreshPage().catch(error => console.error('[Live] Refresh failed:', error))
  }

  async refreshPage(reconnectAttempt = 0): Promise<void> {
    const revision = ++this.revision
    this.closeSocket()
    if (this.destroyed)
      return
    const uuid = this.activeUuid
    this.nodesStore.pageLoading = true
    try {
      if (uuid) {
        const server = await fetchServer(uuid)
        if (revision !== this.revision || this.destroyed)
          return
        const { client, status } = adaptServer(server)
        invalidateHistoryRequests()
        this.nodesStore.initNodes({ [client.uuid]: client }, { [client.uuid]: status }, false)
        this.applyBatch({ type: 'batchUpdate', updates: server.latestReportUpdates }, uuid)
        this.flushPendingStatuses()
      }
      else {
        const { clients, statuses, latestReportUpdates, sysConfig } = await fetchAllServers()
        if (revision !== this.revision || this.destroyed)
          return
        this.nodesStore.configurePingHistory({
          showThreeNetDetails: sysConfig?.show_three_net_details === undefined || isEnabledValue(sysConfig.show_three_net_details),
        })
        invalidateHistoryRequests()
        this.nodesStore.initNodes(clients, statuses)
        this.applyBatch({ type: 'batchUpdate', updates: latestReportUpdates })
        this.flushPendingStatuses()
      }
      this.nodesStore.refreshOnlineState()
      this.reconnectAttempts = reconnectAttempt
      this.connectSocket(uuid, revision)
    }
    catch (error) {
      if (revision !== this.revision || this.destroyed)
        return
      if (error instanceof ApiError && [401, 403, 404].includes(error.code ?? 0))
        this.nodesStore.clearNodes()
      else
        this.scheduleReconnect(revision, reconnectAttempt + 1)
      throw error
    }
    finally {
      if (revision === this.revision)
        this.nodesStore.pageLoading = false
    }
  }

  private applyLiveSample(sample: LiveSample): void {
    const uuid = sample.serverId
    const currentNode = this.nodesStore.nodesByUuid.get(uuid)
    const current = this.pendingStatuses.get(uuid) ?? currentNode
    const { client, status } = adaptServer({
      id: sample.serverId,
      ...sample.data,
      boot_time: normalizeSampleTimestamp(sample.data.boot_time, 0) || Date.parse(currentNode?.boot_time ?? ''),
      last_updated: sample.ts,
    })

    this.nodesStore.recordPingSample(uuid, status)
    if (current && sample.ts < Date.parse(current.time))
      return

    if (currentNode && client.boot_time)
      currentNode.boot_time = client.boot_time

    if (current) {
      if (!sampleHasField(sample.data, 'cpu'))
        status.cpu = current.cpu
      if (!sampleHasField(sample.data, 'ram_used'))
        status.ram = current.ram
      if (!sampleHasField(sample.data, 'net_in_speed', 'net_in'))
        status.net_in = current.net_in
      if (!sampleHasField(sample.data, 'net_out_speed', 'net_out'))
        status.net_out = current.net_out
      if (!sampleHasField(sample.data, 'net_tx', 'net_total_up'))
        status.net_total_up = current.net_total_up
      if (!sampleHasField(sample.data, 'net_rx', 'net_total_down'))
        status.net_total_down = current.net_total_down
      if (!sampleHasField(sample.data, 'net_tx_monthly'))
        status.net_monthly_up = current.net_monthly_up
      if (!sampleHasField(sample.data, 'net_rx_monthly'))
        status.net_monthly_down = current.net_monthly_down
      if (!sampleHasField(sample.data, 'ram_total'))
        status.ram_total = 'ram_total' in current ? current.ram_total : current.mem_total
      if (!sampleHasField(sample.data, 'swap_total'))
        status.swap_total = current.swap_total
      if (!sampleHasField(sample.data, 'swap_used'))
        status.swap = current.swap
      if (!sampleHasField(sample.data, 'disk_total'))
        status.disk_total = current.disk_total
      if (!sampleHasField(sample.data, 'disk_used'))
        status.disk = current.disk
      if (!sampleHasField(sample.data, 'load_avg')) {
        status.load = current.load
        status.load5 = current.load5
        status.load15 = current.load15
      }
      if (!sampleHasField(sample.data, 'processes'))
        status.process = current.process
      if (!sampleHasField(sample.data, 'tcp_conn'))
        status.connections = current.connections
      if (!sampleHasField(sample.data, 'udp_conn'))
        status.connections_udp = current.connections_udp
      if (!sampleHasField(sample.data, 'gpu'))
        status.gpu = current.gpu
      if (!sampleHasField(sample.data, 'temp'))
        status.temp = current.temp
      status.ping = mergeServerPingSample(sample.data, current.ping)
    }

    this.pendingStatuses.set(uuid, status)
  }

  private flushPendingStatuses(): void {
    if (!this.pendingStatuses.size)
      return
    const statuses = Object.fromEntries(this.pendingStatuses)
    this.pendingStatuses.clear()
    this.nodesStore.updateNodeStatuses(statuses)
  }

  private applyBatch(message: WsMessage, serverId: string | null = null): void {
    for (const update of Array.isArray(message.updates) ? message.updates : []) {
      if (!update || typeof update.serverId !== 'string')
        continue
      if (serverId && update.serverId !== serverId)
        continue
      const uuid = update.serverId
      if (!this.nodesStore.nodesByUuid.has(uuid))
        continue
      const samples = (Array.isArray(update.samples) ? update.samples : []).flatMap((sample) => {
        if (!sample)
          return []
        const data = sample.data ?? sample.payload ?? sample.metrics
        if (!data || typeof data !== 'object' || Array.isArray(data))
          return []
        return [{
          serverId: update.serverId,
          ts: normalizeSampleTimestamp(sample.ts ?? sample.timestamp ?? data.sample_timestamp ?? data.last_updated ?? data.timestamp ?? message.ts),
          data,
        }]
      }).sort((a, b) => a.ts - b.ts)
      for (const sample of samples)
        this.applyLiveSample(sample)
    }
  }

  private connectSocket(serverId: string | null, revision: number): void {
    if (this.destroyed || revision !== this.revision)
      return
    const url = new URL('/api/ws', window.location.origin)
    url.searchParams.set('subscribe', serverId ?? 'all')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    const isCurrent = () => !this.destroyed && revision === this.revision && this.socket === socket

    socket.addEventListener('open', () => {
      if (!isCurrent())
        return
      this.reconnectAttempts = 0
      // Explicit subscription also asks the backend to resume fast agent reports.
      socket.send(JSON.stringify({
        type: 'subscribe',
        scope: serverId ?? 'all',
        ids: serverId ? [serverId] : this.nodesStore.nodes.map(node => node.uuid),
      }))
    })
    socket.addEventListener('message', (event) => {
      if (!isCurrent())
        return
      let message: WsMessage
      try {
        message = JSON.parse(String(event.data)) as WsMessage
      }
      catch {
        return
      }
      if (message?.type === 'batchUpdate')
        this.applyBatch(message, serverId)
    })
    socket.addEventListener('close', () => {
      if (!isCurrent())
        return
      this.socket = null
      this.scheduleReconnect(revision, this.reconnectAttempts + 1)
    })
    socket.addEventListener('error', () => socket.close())
  }

  private scheduleReconnect(revision: number, attempts: number): void {
    if (this.destroyed || revision !== this.revision)
      return
    this.reconnectAttempts = attempts
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.destroyed && revision === this.revision)
        void this.refreshPage(attempts).catch(error => console.error('[Live] Reconnect failed:', error))
    }, delay)
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    socket?.close()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectAttempts = 0
    this.flushPendingStatuses()
  }

  destroy(): void {
    this.destroyed = true
    this.revision++
    this.stopRouteWatch?.()
    this.closeSocket()
    if (this.liveUpdateTimer)
      clearInterval(this.liveUpdateTimer)
    this.liveUpdateTimer = null
    this.nodesStore.pageLoading = false
  }
}

let initManager: InitManager | null = null

export async function initApp(): Promise<void> {
  initManager ??= new InitManager()
  await initManager.init()
}

export function destroyInitManager(): void {
  initManager?.destroy()
  initManager = null
}
