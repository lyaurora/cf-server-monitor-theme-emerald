import type { WatchStopHandle } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { NodeStatus } from '@/utils/rpc'
import { watch } from 'vue'
import { toast } from 'vue-sonner'
import router from '@/router'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import {
  adaptServer,
  ApiError,
  buildAdminUrl,
  fetchAllServers,
  fetchServer,
  fetchSiteConfig,
  getPublicSettings,
  invalidateHistoryRequests,
  isEnabledValue,
  mergeServerPingSample,
  refreshTurnstileSession,
  timestamp,
} from '@/utils/api'

const CONNECTION_NOTICE_DELAY_MS = 30_000

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

// Status field -> sample keys; carried over from the previous status when the sample omits them.
const LIVE_STATUS_FIELDS: Array<[keyof NodeStatus & keyof NodeData, string[]]> = [
  ['cpu', ['cpu']],
  ['ram', ['ram_used']],
  ['net_in', ['net_in_speed', 'net_in']],
  ['net_out', ['net_out_speed', 'net_out']],
  ['net_total_up', ['net_tx', 'net_total_up']],
  ['net_total_down', ['net_rx', 'net_total_down']],
  ['net_monthly_up', ['net_tx_monthly']],
  ['net_monthly_down', ['net_rx_monthly']],
  ['swap_total', ['swap_total']],
  ['swap', ['swap_used']],
  ['disk_total', ['disk_total']],
  ['disk', ['disk_used']],
  ['process', ['processes']],
  ['connections', ['tcp_conn']],
  ['connections_udp', ['udp_conn']],
  ['gpu', ['gpu']],
  ['temp', ['temp']],
]

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
  private connectionIssue: 'retrying' | 'failed' | null = null
  private connectionFailedAt: number | null = null
  private connectionNoticeId: string | number | undefined

  private get activeUuid(): string | null {
    const route = router.currentRoute.value
    return route.name === 'instance-detail' ? String(route.params.id) : null
  }

  async init(): Promise<void> {
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    try {
      let config = await fetchSiteConfig()
      if (this.destroyed)
        return
      if (isEnabledValue(config.turnstile_enabled) && !config.verified) {
        if (!config.turnstile_site_key)
          throw new Error('源站已启用 Turnstile，但未返回 Site Key')
        if (!await refreshTurnstileSession())
          throw new Error('Turnstile 验证失败')
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
      // Failures before page setup have no automatic retry path.
      if (!this.stopRouteWatch)
        this.reportConnectionIssue('failed')
      throw error
    }
    finally {
      if (!this.destroyed)
        this.appStore.loading = false
    }
  }

  private reloadPage = (): void => {
    this.clearConnectionNotice()
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
      if (error instanceof ApiError && [401, 403, 404].includes(error.code ?? 0)) {
        this.nodesStore.clearNodes()
        this.clearConnectionNotice()
        // Missing nodes already have an empty state; access failures need an action.
        if (error.code !== 404)
          this.reportConnectionIssue('failed')
      }
      else {
        this.scheduleReconnect(revision, reconnectAttempt + 1)
      }
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
      boot_time: Math.max(0, timestamp(sample.data.boot_time, 0)) || Date.parse(currentNode?.boot_time ?? ''),
      last_updated: sample.ts,
    })

    this.nodesStore.recordPingSample(uuid, status)
    if (current && sample.ts < Date.parse(current.time))
      return

    if (currentNode && client.boot_time)
      currentNode.boot_time = client.boot_time

    if (current) {
      for (const [field, keys] of LIVE_STATUS_FIELDS) {
        if (!sampleHasField(sample.data, ...keys))
          Object.assign(status, { [field]: current[field] })
      }
      if (!sampleHasField(sample.data, 'ram_total'))
        status.ram_total = 'ram_total' in current ? current.ram_total : current.mem_total
      if (!sampleHasField(sample.data, 'load_avg')) {
        status.load = current.load
        status.load5 = current.load5
        status.load15 = current.load15
      }
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
          ts: timestamp(sample.ts ?? sample.timestamp ?? data.sample_timestamp ?? data.last_updated ?? data.timestamp ?? message.ts),
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
      // A fresh HTTP snapshot and an open socket confirm recovery together.
      this.clearConnectionNotice()
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
      if (message?.type === 'batchUpdate') {
        // Reset backoff only once data flows, so post-handshake closes still back off.
        this.reconnectAttempts = 0
        this.applyBatch(message, serverId)
      }
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
    this.reportConnectionIssue('retrying')
    this.reconnectAttempts = attempts
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.destroyed && revision === this.revision)
        void this.refreshPage(attempts).catch(error => console.error('[Live] Reconnect failed:', error))
    }, delay)
  }

  private reportConnectionIssue(issue: 'retrying' | 'failed'): void {
    if (this.connectionIssue !== issue)
      this.clearConnectionNotice()
    this.connectionIssue = issue
    this.connectionFailedAt ??= performance.now()
    // Keep the ID after manual dismissal: one notice per uninterrupted failure.
    if (document.hidden || this.connectionNoticeId !== undefined)
      return
    const retrying = issue === 'retrying'
    // Require a failed retry after the grace period, not just elapsed time.
    if (retrying && performance.now() - this.connectionFailedAt < CONNECTION_NOTICE_DELAY_MS)
      return
    this.connectionNoticeId = toast.warning(retrying ? '实时连接暂时中断' : '暂时无法加载数据', {
      description: retrying
        ? '正在重连，数据可能延迟。'
        : '请检查网络或权限后重试。',
      class: 'connection-notice',
      richColors: false,
      duration: Number.POSITIVE_INFINITY,
      action: { label: '刷新页面', onClick: () => window.location.reload() },
    })
  }

  private clearConnectionNotice(): void {
    this.connectionFailedAt = null
    if (this.connectionNoticeId !== undefined)
      toast.dismiss(this.connectionNoticeId)
    this.connectionNoticeId = undefined
    this.connectionIssue = null
  }

  private handleVisibilityChange = (): void => {
    // Returning from the background starts a fresh grace period.
    this.connectionFailedAt = null
    if (document.hidden) {
      if (this.connectionNoticeId !== undefined)
        toast.dismiss(this.connectionNoticeId)
      this.connectionNoticeId = undefined
    }
    else if (this.connectionIssue) {
      this.reportConnectionIssue(this.connectionIssue)
    }
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
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.clearConnectionNotice()
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
