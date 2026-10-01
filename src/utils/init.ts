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
  fetchSiteConfigs,
  getDisplayUuid,
  getRegisteredServerIds,
  getServerSource,
  getSharedApi,
  getWebSocketBases,
  hasMultipleApiBases,
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
  private sockets = new Map<number, WebSocket>()
  private reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private reconnectAttempts = new Map<number, number>()
  private timeoutTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private timeoutMinutes = 0
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
      let configs = await fetchSiteConfigs()
      if (this.destroyed)
        return
      const turnstileConfigs = configs.filter(config => isEnabledValue(config.turnstile_enabled))
      if (hasMultipleApiBases() && turnstileConfigs.length)
        throw new Error('多后端聚合模式暂不支持启用 Turnstile 的源站')

      const first = configs[0]
      if (first && isEnabledValue(first.turnstile_enabled) && !first.verified) {
        if (!first.turnstile_site_key)
          throw new Error('源站已启用 Turnstile，但未返回 Site Key')
        const token = await requestTurnstileToken(first.turnstile_site_key)
        if (this.destroyed)
          return
        localStorage.setItem('turnstile_token', token)
        await cfRequest('/api/config', 0)
        if (this.destroyed)
          return
        configs = await fetchSiteConfigs()
      }
      if (this.destroyed)
        return

      const config = configs[0]
      if (config?.site_title && !hasMultipleApiBases())
        document.title = config.site_title
      if (config && !isEnabledValue(config.is_public) && !config.authorization) {
        window.location.href = buildAdminUrl()
        return
      }

      const publicSettings = await getSharedApi().getPublicSettings()
      if (this.destroyed)
        return
      this.appStore.publicSettings = publicSettings
      this.appStore.updateLoginState(configs.some(item => item.authorization))
      const minutes = Number(config?.frontend_ws_timeout_minutes)
      this.timeoutMinutes = Number.isInteger(minutes) && minutes > 0 ? Math.min(minutes, 1440) : 0
      this.nodesStore.configurePingHistory({
        points: config?.latency_window?.points,
        hours: config?.latency_window?.hours,
      })
      await router.isReady()
      if (this.destroyed)
        return
      this.stopRouteWatch = watch(() => router.currentRoute.value.fullPath, this.reloadPage)
      document.addEventListener('visibilitychange', this.onVisibilityChange)
      this.liveUpdateTimer = setInterval(() => {
        this.flushPendingStatuses()
        this.nodesStore.refreshOnlineState()
      }, 1000)
      await this.refreshPage()
    }
    catch (error) {
      if (this.destroyed)
        return
      this.appStore.connectionError = true
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

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.revision++
      this.closeSockets()
      this.nodesStore.pageLoading = false
    }
    else {
      this.reloadPage()
    }
  }

  async refreshPage(reconnectAttempt = 0): Promise<void> {
    const revision = ++this.revision
    this.closeSockets()
    if (this.destroyed || document.hidden)
      return
    const uuid = this.activeUuid
    this.nodesStore.pageLoading = true
    try {
      if (uuid) {
        const source = getServerSource(uuid)
        const server = await fetchServer(uuid)
        if (revision !== this.revision || this.destroyed)
          return
        const { client, status } = adaptServer(server, source.apiIndex)
        this.nodesStore.initNodes({ [client.uuid]: client }, { [client.uuid]: status }, false)
        this.applyBatch(source.apiIndex, { type: 'batchUpdate', updates: server.latestReportUpdates }, source.serverId)
        this.flushPendingStatuses()
      }
      else {
        const { clients, statuses, latestReportUpdates, sysConfig } = await fetchAllServers()
        if (revision !== this.revision || this.destroyed)
          return
        this.nodesStore.configurePingHistory({
          showThreeNetDetails: sysConfig?.show_three_net_details === undefined || isEnabledValue(sysConfig.show_three_net_details),
        })
        this.nodesStore.initNodes(clients, statuses)
        for (const { apiIndex, updates } of latestReportUpdates)
          this.applyBatch(apiIndex, { type: 'batchUpdate', updates })
        this.flushPendingStatuses()
      }
      this.nodesStore.refreshOnlineState()
      this.appStore.connectionError = false
      if (!this.nodesStore.livePaused) {
        if (reconnectAttempt > 0)
          this.reconnectAttempts.set(0, reconnectAttempt)
        if (uuid) {
          const { apiIndex, serverId } = getServerSource(uuid)
          this.connectSocket(apiIndex, serverId, revision)
        }
        else {
          getWebSocketBases().forEach((_, apiIndex) => this.connectSocket(apiIndex, null, revision))
        }
      }
    }
    catch (error) {
      if (revision !== this.revision || this.destroyed)
        return
      this.appStore.connectionError = true
      if (error instanceof ApiError && [401, 403, 404].includes(error.code ?? 0))
        this.nodesStore.clearNodes()
      else
        this.scheduleReconnect(0, revision, reconnectAttempt + 1)
      throw error
    }
    finally {
      if (revision === this.revision)
        this.nodesStore.pageLoading = false
    }
  }

  private applyLiveSample(apiIndex: number, sample: LiveSample): void {
    const uuid = getDisplayUuid(apiIndex, sample.serverId)
    const currentNode = this.nodesStore.nodesByUuid.get(uuid)
    const current = this.pendingStatuses.get(uuid) ?? currentNode
    const status = adaptServer({
      id: sample.serverId,
      ...sample.data,
      last_updated: sample.ts,
    }, apiIndex).status

    this.nodesStore.recordPingSample(uuid, status)
    if (current && sample.ts < Date.parse(current.time))
      return

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
      if (!sampleHasField(sample.data, 'boot_time'))
        status.uptime = current.uptime + Math.max(0, Math.floor((sample.ts - Date.parse(current.time)) / 1000))
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

    this.queueNodeStatuses({ [uuid]: status })
  }

  private queueNodeStatuses(statuses: Record<string, NodeStatus>): void {
    for (const [uuid, status] of Object.entries(statuses))
      this.pendingStatuses.set(uuid, status)
  }

  private flushPendingStatuses(): void {
    if (!this.pendingStatuses.size)
      return
    const statuses = Object.fromEntries(this.pendingStatuses)
    this.pendingStatuses.clear()
    this.nodesStore.updateNodeStatuses(statuses, false)
  }

  private applyBatch(apiIndex: number, message: WsMessage, serverId: string | null = null): void {
    for (const update of Array.isArray(message.updates) ? message.updates : []) {
      if (!update || typeof update.serverId !== 'string')
        continue
      if (serverId && update.serverId !== serverId)
        continue
      const uuid = getDisplayUuid(apiIndex, update.serverId)
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
        this.applyLiveSample(apiIndex, sample)
    }
  }

  private connectSocket(apiIndex: number, serverId: string | null, revision: number): void {
    if (this.destroyed || document.hidden || this.nodesStore.livePaused || revision !== this.revision)
      return
    const baseUrl = getWebSocketBases()[apiIndex] ?? ''
    const url = new URL(`${baseUrl}/api/ws`, window.location.origin)
    url.searchParams.set('subscribe', serverId ?? 'all')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.sockets.set(apiIndex, socket)
    const isCurrent = () => !this.destroyed && revision === this.revision && this.sockets.get(apiIndex) === socket
    this.nodesStore.updateWsState(this.reconnectAttempts.get(apiIndex) ? 'reconnecting' : 'connecting', this.reconnectAttempts.get(apiIndex) ?? 0)

    socket.addEventListener('open', () => {
      if (!isCurrent())
        return
      this.reconnectAttempts.set(apiIndex, 0)
      if (!serverId) {
        socket.send(JSON.stringify({
          type: 'subscribe',
          scope: 'all',
          ids: getRegisteredServerIds(apiIndex),
        }))
      }
      this.nodesStore.updateWsState('connected', 0)
      if (this.timeoutMinutes > 0) {
        this.timeoutTimers.set(apiIndex, setTimeout(() => {
          if (!isCurrent())
            return
          this.nodesStore.livePaused = true
          this.closeSockets()
        }, this.timeoutMinutes * 60_000))
      }
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
        this.applyBatch(apiIndex, message, serverId)
    })
    socket.addEventListener('close', () => {
      if (!isCurrent())
        return
      const timeout = this.timeoutTimers.get(apiIndex)
      if (timeout)
        clearTimeout(timeout)
      this.timeoutTimers.delete(apiIndex)
      this.sockets.delete(apiIndex)
      const attempts = (this.reconnectAttempts.get(apiIndex) ?? 0) + 1
      this.scheduleReconnect(apiIndex, revision, attempts)
    })
    socket.addEventListener('error', () => socket.close())
  }

  private scheduleReconnect(apiIndex: number, revision: number, attempts: number): void {
    if (this.destroyed || document.hidden || this.nodesStore.livePaused || revision !== this.revision)
      return
    this.reconnectAttempts.set(apiIndex, attempts)
    this.nodesStore.updateWsState('reconnecting', attempts)
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
    this.reconnectTimers.set(apiIndex, setTimeout(() => {
      this.reconnectTimers.delete(apiIndex)
      if (!this.destroyed && revision === this.revision)
        void this.refreshPage(attempts).catch(error => console.error('[Live] Reconnect failed:', error))
    }, delay))
  }

  private closeSockets(): void {
    const sockets = [...this.sockets.values()]
    this.sockets.clear()
    sockets.forEach(socket => socket.close())
    this.reconnectTimers.forEach(timer => clearTimeout(timer))
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()
    this.timeoutTimers.forEach(timer => clearTimeout(timer))
    this.timeoutTimers.clear()
    this.flushPendingStatuses()
    this.nodesStore.updateWsState('disconnected', 0)
  }

  async resume(): Promise<void> {
    this.nodesStore.livePaused = false
    await this.refreshPage()
  }

  destroy(): void {
    this.destroyed = true
    this.revision++
    this.stopRouteWatch?.()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.closeSockets()
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

export async function resumeLiveUpdates(): Promise<void> {
  await initManager?.resume()
}
