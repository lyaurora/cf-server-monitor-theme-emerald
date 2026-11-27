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
  getCachedSiteConfig,
  getPublicSettings,
  invalidateHistoryRequests,
  isEnabledValue,
  mergeServerPingSample,
  refreshTurnstileSession,
  setUnauthorizedHandler,
  timestamp,
} from '@/utils/api'

const CONNECTION_NOTICE_DELAY_MS = 30_000
const SOCKET_STABLE_CONFIRM_MS = 5_000
const BACKGROUND_RESYNC_THRESHOLD_MS = 60_000
const BACKGROUND_DISCONNECT_DELAY_MS = 120_000
const SOCKET_IDLE_RESYNC_MS = 120_000
const MAX_WS_TIMEOUT_MINUTES = 1440
const MAX_RECONNECT_ATTEMPTS = 6

function parseWsTimeoutMinutes(value: unknown): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes <= 0)
    return 0
  return Math.min(MAX_WS_TIMEOUT_MINUTES, Math.round(minutes))
}

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
  [
    'cpu',
    ['cpu'],
  ],
  [
    'ram',
    ['ram_used'],
  ],
  [
    'net_in',
    ['net_in_speed', 'net_in'],
  ],
  [
    'net_out',
    ['net_out_speed', 'net_out'],
  ],
  [
    'net_total_up',
    ['net_tx', 'net_total_up'],
  ],
  [
    'net_total_down',
    ['net_rx', 'net_total_down'],
  ],
  [
    'net_monthly_up',
    ['net_tx_monthly'],
  ],
  [
    'net_monthly_down',
    ['net_rx_monthly'],
  ],
  [
    'swap_total',
    ['swap_total'],
  ],
  [
    'swap',
    ['swap_used'],
  ],
  [
    'disk_total',
    ['disk_total'],
  ],
  [
    'disk',
    ['disk_used'],
  ],
  [
    'process',
    ['processes'],
  ],
  [
    'connections',
    ['tcp_conn'],
  ],
  [
    'connections_udp',
    ['udp_conn'],
  ],
  [
    'gpu',
    ['gpu'],
  ],
  [
    'temp',
    ['temp'],
  ],
]

function sampleHasField(data: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some(key => data[key] !== undefined && data[key] !== null && data[key] !== '')
}

class InitManager {
  private appStore = useAppStore()
  private nodesStore = useNodesStore()
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private socketStableTimer: ReturnType<typeof setTimeout> | undefined
  private wsTimeoutTimer: ReturnType<typeof setTimeout> | undefined
  private backgroundDisconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private liveUpdateTimer: ReturnType<typeof setInterval> | null = null
  private pendingStatuses = new Map<string, NodeStatus>()
  private stopRouteWatch: WatchStopHandle | null = null
  private revision = 0
  private destroyed = false
  private connectionIssue: 'retrying' | 'failed' | 'timeout' | null = null
  private connectionDetail: string | undefined
  private connectionFailedAt: number | null = null
  private connectionNoticeId: string | number | undefined
  private connectionNoticeDismissed = false
  private suppressingNoticeDismiss = false
  private lastSocketActivityAt = 0
  private hiddenAt: number | null = null
  private frontendWsTimeoutMinutes = 0
  private wsTimedOut = false
  private pausedForBackground = false
  private terminalFailure = false

  private get activeUuid(): string | null {
    const route = router.currentRoute.value
    return route.name === 'instance-detail'
      ? String(route.params.id)
      : null
  }

  async init(): Promise<void> {
    setUnauthorizedHandler(this.handleUnauthorized)
    if (document.hidden)
      this.hiddenAt = performance.now()
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('online', this.handleOnline)
    let redirecting = false
    try {
      let config = await fetchSiteConfig()
      if (this.destroyed)
        return
      if (config.site_title)
        document.title = config.site_title
      if (!isEnabledValue(config.is_public) && !config.authorization) {
        redirecting = true
        window.location.href = buildAdminUrl()
        return
      }
      if (isEnabledValue(config.turnstile_enabled) && !config.verified) {
        if (!config.turnstile_site_key)
          throw new Error('源站已启用 Turnstile，但未返回 Site Key')
        if (!await refreshTurnstileSession())
          throw new Error('Turnstile 验证失败')
        if (this.destroyed)
          return
        config = getCachedSiteConfig() ?? await fetchSiteConfig()
      }
      if (this.destroyed)
        return

      if (config.site_title)
        document.title = config.site_title
      if (!isEnabledValue(config.is_public) && !config.authorization) {
        redirecting = true
        window.location.href = buildAdminUrl()
        return
      }

      const publicSettings = await getPublicSettings()
      if (this.destroyed)
        return
      this.appStore.publicSettings = publicSettings
      this.appStore.updateLoginState(config.authorization)
      this.frontendWsTimeoutMinutes = parseWsTimeoutMinutes(config.frontend_ws_timeout_minutes)
      this.nodesStore.configurePingHistory({
        points: config.latency_window?.points,
        hours: config.latency_window?.hours,
      })
      await router.isReady()
      if (this.destroyed)
        return
      this.stopRouteWatch = watch(
        () => [router.currentRoute.value.name, router.currentRoute.value.params.id],
        this.reloadPage,
      )
      this.liveUpdateTimer = setInterval(() => {
        this.flushPendingStatuses()
        // A disconnected or background-throttled browser cannot infer outages from its stale snapshot.
        if (!document.hidden && this.socket?.readyState === WebSocket.OPEN)
          this.nodesStore.refreshOnlineState()
      }, 1000)
      await this.refreshPage()
    }
    catch (error) {
      if (this.destroyed)
        return
      // Failures before page setup have no automatic retry path.
      if (!this.stopRouteWatch) {
        this.terminalFailure = true
        this.reportConnectionIssue('failed')
      }
      throw error
    }
    finally {
      if (!this.destroyed && !redirecting)
        this.appStore.loading = false
    }
  }

  private reloadPage = (): void => {
    this.terminalFailure = false
    if (this.connectionIssue !== 'timeout')
      this.clearConnectionNotice()
    void this.refreshPage().catch(error => console.error('[Live] Refresh failed:', error))
  }

  private syncLongHistoryPoints(points: unknown): void {
    const num = Number(points)
    if (!Number.isFinite(num) || num <= 0 || !this.appStore.publicSettings)
      return
    const normalized = Math.round(num)
    if (this.appStore.publicSettings.long_history_points !== normalized) {
      this.appStore.publicSettings = {
        ...this.appStore.publicSettings,
        long_history_points: normalized,
      }
    }
  }

  async refreshPage(reconnectAttempt = 0, isResync = false): Promise<void> {
    const revision = ++this.revision
    this.closeSocket()
    if (this.destroyed)
      return
    const uuid = this.activeUuid
    this.terminalFailure = false
    this.nodesStore.pageLoading = true
    this.nodesStore.pageError = null
    try {
      if (uuid) {
        const server = await fetchServer(uuid)
        if (revision !== this.revision || this.destroyed)
          return
        this.syncLongHistoryPoints(server.sysConfig?.long_history_points)
        const { client, status } = adaptServer(server)
        if (isResync)
          invalidateHistoryRequests()
        this.nodesStore.initNodes({ [client.uuid]: client }, { [client.uuid]: status }, false)
        if (isResync)
          this.nodesStore.notifyResync()
        this.applyBatch({ type: 'batchUpdate', updates: server.latestReportUpdates }, uuid)
        this.flushPendingStatuses()
      }
      else {
        const { clients, statuses, latestReportUpdates, sysConfig } = await fetchAllServers()
        if (revision !== this.revision || this.destroyed)
          return
        this.syncLongHistoryPoints(sysConfig?.long_history_points)
        this.nodesStore.configurePingHistory({
          showThreeNetDetails: sysConfig?.show_three_net_details === undefined || isEnabledValue(sysConfig.show_three_net_details),
        })
        if (isResync)
          invalidateHistoryRequests()
        this.nodesStore.initNodes(clients, statuses)
        if (isResync)
          this.nodesStore.notifyResync()
        this.applyBatch({ type: 'batchUpdate', updates: latestReportUpdates })
        this.flushPendingStatuses()
      }
      this.nodesStore.refreshOnlineState()
      this.reconnectAttempts = reconnectAttempt
      if (this.wsTimedOut) {
        if (this.connectionIssue !== 'timeout')
          this.reportConnectionIssue('timeout')
      }
      else if (!this.pausedForBackground) {
        if (document.hidden && this.hiddenAt !== null && performance.now() - this.hiddenAt >= BACKGROUND_DISCONNECT_DELAY_MS) {
          this.pausedForBackground = true
        }
        else {
          this.connectSocket(uuid, revision)
          if (document.hidden)
            this.scheduleBackgroundDisconnect()
        }
      }
    }
    catch (error) {
      if (revision !== this.revision || this.destroyed)
        return
      if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.code ?? 0)) {
        this.terminalFailure = true
        this.clearBackgroundDisconnectTimer()
        if ((error.code === 404 || error.code === 400) && uuid) {
          this.nodesStore.removeNode(uuid)
          this.nodesStore.pageError = 'not-found'
        }
        else {
          this.nodesStore.clearNodes()
          this.nodesStore.pageError = error.code === 404 || error.code === 400
            ? 'not-found'
            : error.code === 409
              ? 'upgrade'
              : 'forbidden'
        }
        // Missing nodes already have an empty state; access/upgrade failures need an action.
        if (error.code === 404) {
          if (this.connectionIssue !== 'timeout')
            this.clearConnectionNotice()
        }
        else {
          this.clearConnectionNotice()
          this.reportConnectionIssue(
            'failed',
            error.code === 409
              ? error.message
              : undefined,
          )
        }
      }
      else {
        this.nodesStore.pageError = 'network'
        if (document.hidden)
          this.scheduleBackgroundDisconnect()
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
      // Ensure report_timestamp inside sample.data cannot override this sample's own timestamp.
      report_timestamp: sample.ts,
      last_updated: sample.ts,
    } as Parameters<typeof adaptServer>[0])

    this.nodesStore.recordPingSample(uuid, status)
    if (current && sample.ts < Date.parse(current.time))
      return

    if (currentNode && client.boot_time)
      currentNode.boot_time = client.boot_time
    if (currentNode && client.gpu_name) {
      currentNode.gpu_info = client.gpu_info
      currentNode.gpu_name = client.gpu_name
    }

    if (current) {
      for (const [field, keys] of LIVE_STATUS_FIELDS) {
        if (!sampleHasField(sample.data, ...keys))
          Object.assign(status, { [field]: current[field] })
      }
      if (!sampleHasField(sample.data, 'ram_total')) {
        status.ram_total = 'ram_total' in current
          ? current.ram_total
          : current.mem_total
      }
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
    for (const update of Array.isArray(message.updates)
      ? message.updates
      : []) {
      if (!update || typeof update.serverId !== 'string')
        continue
      if (serverId && update.serverId !== serverId)
        continue
      const uuid = update.serverId
      if (!this.nodesStore.nodesByUuid.has(uuid))
        continue
      const samples = (Array.isArray(update.samples)
        ? update.samples
        : []).flatMap((sample) => {
        if (!sample)
          return []
        const data = sample.data ?? sample.payload ?? sample.metrics
        if (!data || typeof data !== 'object' || Array.isArray(data))
          return []
        return [
          {
            serverId: update.serverId,
            ts: timestamp(sample.ts ?? sample.timestamp ?? data.sample_timestamp ?? data.last_updated ?? data.timestamp ?? message.ts),
            data,
          },
        ]
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
    url.protocol = url.protocol === 'https:'
      ? 'wss:'
      : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    const isCurrent = () => !this.destroyed && revision === this.revision && this.socket === socket

    socket.addEventListener('open', () => {
      if (!isCurrent())
        return
      this.lastSocketActivityAt = performance.now()
      // Confirm recovery after data flows or a short stable open window, so post-handshake close loops still surface a notice.
      clearTimeout(this.socketStableTimer)
      if (!this.nodesStore.nodes.length) {
        this.clearConnectionNotice()
      }
      else {
        this.socketStableTimer = setTimeout(() => {
          this.socketStableTimer = undefined
          if (isCurrent() && socket.readyState === WebSocket.OPEN)
            this.clearConnectionNotice()
        }, SOCKET_STABLE_CONFIRM_MS)
      }
      // Explicit subscription also asks the backend to resume fast agent reports.
      socket.send(JSON.stringify({
        type: 'subscribe',
        scope: serverId ?? 'all',
        ids: serverId
          ? [serverId]
          : this.nodesStore.nodes.map(node => node.uuid).slice(0, 500),
      }))
      this.scheduleWsTimeout(revision, socket)
    })
    socket.addEventListener('message', (event) => {
      if (!isCurrent())
        return
      this.lastSocketActivityAt = performance.now()
      let message: WsMessage
      try {
        message = JSON.parse(String(event.data)) as WsMessage
      }
      catch {
        return
      }
      if (message?.type === 'batchUpdate') {
        // Reset backoff and notice only once data flows, so post-handshake closes still back off.
        this.reconnectAttempts = 0
        this.clearConnectionNotice()
        this.applyBatch(message, serverId)
      }
    })
    socket.addEventListener('close', (event) => {
      if (!isCurrent())
        return
      clearTimeout(this.socketStableTimer)
      this.socketStableTimer = undefined
      clearTimeout(this.wsTimeoutTimer)
      this.wsTimeoutTimer = undefined
      this.socket = null
      if (event.code === 1008) {
        this.terminalFailure = true
        this.clearBackgroundDisconnectTimer()
        this.reportConnectionIssue('failed')
        return
      }
      this.scheduleReconnect(revision, this.reconnectAttempts + 1)
    })
    socket.addEventListener('error', () => socket.close())
  }

  private scheduleReconnect(revision: number, attempts: number): void {
    if (this.destroyed || revision !== this.revision || this.pausedForBackground || this.terminalFailure)
      return
    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      this.reportConnectionIssue('failed', '多次重连失败，已停止自动重试，请检查网络后刷新页面。')
      return
    }
    this.reportConnectionIssue('retrying')
    this.reconnectAttempts = attempts
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.destroyed && revision === this.revision)
        void this.refreshPage(attempts, true).catch(error => console.error('[Live] Reconnect failed:', error))
    }, delay)
  }

  private scheduleWsTimeout(revision: number, socket: WebSocket): void {
    clearTimeout(this.wsTimeoutTimer)
    this.wsTimeoutTimer = undefined
    if (this.frontendWsTimeoutMinutes <= 0)
      return
    this.wsTimeoutTimer = setTimeout(() => {
      this.wsTimeoutTimer = undefined
      if (this.destroyed || revision !== this.revision || this.socket !== socket)
        return
      this.wsTimedOut = true
      this.pausedForBackground = false
      this.clearBackgroundDisconnectTimer()
      this.closeSocket()
      this.reportConnectionIssue('timeout')
    }, this.frontendWsTimeoutMinutes * 60_000)
  }

  private resumeFromWsTimeout(): void {
    if (this.destroyed)
      return
    this.wsTimedOut = false
    this.pausedForBackground = false
    this.terminalFailure = false
    this.clearConnectionNotice()
    void this.refreshPage(0, true).catch(error => console.error('[Live] Timeout resume failed:', error))
  }

  private clearBackgroundDisconnectTimer(): void {
    clearTimeout(this.backgroundDisconnectTimer)
    this.backgroundDisconnectTimer = undefined
  }

  private scheduleBackgroundDisconnect(): void {
    if (this.destroyed || this.wsTimedOut || this.terminalFailure || !this.stopRouteWatch || this.backgroundDisconnectTimer !== undefined)
      return
    const hiddenSince = this.hiddenAt ?? performance.now()
    this.hiddenAt = hiddenSince
    const remaining = Math.max(0, BACKGROUND_DISCONNECT_DELAY_MS - (performance.now() - hiddenSince))
    this.backgroundDisconnectTimer = setTimeout(() => {
      this.backgroundDisconnectTimer = undefined
      if (this.destroyed || !document.hidden || this.wsTimedOut || this.terminalFailure)
        return
      // Invalidate any in-flight refresh so its rejection cannot restart background polling.
      this.revision++
      this.pausedForBackground = true
      this.nodesStore.pageLoading = false
      this.closeSocket()
    }, remaining)
  }

  private dismissToastSilently(): void {
    if (this.connectionNoticeId === undefined)
      return
    const id = this.connectionNoticeId
    this.connectionNoticeId = undefined
    this.suppressingNoticeDismiss = true
    try {
      toast.dismiss(id)
    }
    finally {
      this.suppressingNoticeDismiss = false
    }
  }

  private reportConnectionIssue(issue: 'retrying' | 'failed' | 'timeout', detail?: string): void {
    if (this.connectionIssue !== issue || this.connectionDetail !== detail)
      this.clearConnectionNotice()
    this.connectionIssue = issue
    this.connectionDetail = detail
    this.connectionFailedAt ??= performance.now()
    // Respect manual dismissal: one notice per uninterrupted failure/timeout.
    if (document.hidden || this.connectionNoticeId !== undefined || this.connectionNoticeDismissed)
      return
    const retrying = issue === 'retrying'
    const timedOut = issue === 'timeout'
    // Require a failed retry after the grace period, not just elapsed time.
    if (retrying && performance.now() - this.connectionFailedAt < CONNECTION_NOTICE_DELAY_MS)
      return
    this.connectionNoticeId = toast.warning(
      timedOut
        ? '实时连接已超时'
        : retrying
          ? '实时连接暂时中断'
          : '暂时无法加载数据',
      {
        description: detail || (timedOut
          ? '已暂停实时更新，点击继续连接可重新订阅。'
          : retrying
            ? '正在重连，数据可能延迟。'
            : '请检查网络或权限后重试。'),
        class: 'connection-notice',
        richColors: false,
        duration: Number.POSITIVE_INFINITY,
        onDismiss: () => {
          if (!this.suppressingNoticeDismiss) {
            this.connectionNoticeId = undefined
            this.connectionNoticeDismissed = true
          }
        },
        action: timedOut
          ? {
              label: '继续连接',
              onClick: () => this.resumeFromWsTimeout(),
            }
          : {
              label: '刷新页面',
              onClick: () => window.location.reload(),
            },
      },
    )
  }

  private clearConnectionNotice(): void {
    this.connectionFailedAt = null
    this.dismissToastSilently()
    this.connectionIssue = null
    this.connectionDetail = undefined
    this.connectionNoticeDismissed = false
  }

  private handleVisibilityChange = (): void => {
    // Returning from the background starts a fresh grace period.
    this.connectionFailedAt = null
    if (document.hidden) {
      this.hiddenAt = performance.now()
      this.dismissToastSilently()
      this.scheduleBackgroundDisconnect()
      return
    }

    this.clearBackgroundDisconnectTimer()
    const hiddenDuration = this.hiddenAt !== null
      ? performance.now() - this.hiddenAt
      : 0
    this.hiddenAt = null

    // If a backoff timer is waiting (including a failed route fetch while wsTimedOut), retry right away.
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      void this.refreshPage(0, true).catch(error => console.error('[Live] Foreground reconnect failed:', error))
      return
    }

    // Never silently reconnect after the backend-configured WS timeout paused the session.
    if (this.wsTimedOut) {
      if (this.connectionIssue === 'failed')
        this.reportConnectionIssue('failed', this.connectionDetail)
      else
        this.reportConnectionIssue('timeout')
      return
    }

    // Do not auto-retry terminal errors (400/401/403/404/409/1008) on tab switch.
    if (this.terminalFailure) {
      if (this.connectionIssue)
        this.reportConnectionIssue(this.connectionIssue, this.connectionDetail)
      return
    }

    if (this.pausedForBackground) {
      this.pausedForBackground = false
      void this.refreshPage(0, true).catch(error => console.error('[Live] Foreground resume failed:', error))
      return
    }

    // Proactively resync if the tab stayed hidden long enough for the OS/NAT to silently drop the socket.
    if (
      this.stopRouteWatch
      && hiddenDuration >= BACKGROUND_RESYNC_THRESHOLD_MS
      && (this.socket?.readyState !== WebSocket.OPEN || performance.now() - this.lastSocketActivityAt >= SOCKET_IDLE_RESYNC_MS)
    ) {
      void this.refreshPage(0, true).catch(error => console.error('[Live] Foreground resync failed:', error))
      return
    }

    if (this.connectionIssue) {
      this.reportConnectionIssue(this.connectionIssue, this.connectionDetail)
    }
  }

  private handleUnauthorized = (): void => {
    this.appStore.updateLoginState(false)
    if (this.appStore.publicSettings) {
      this.appStore.publicSettings = {
        ...this.appStore.publicSettings,
        record_preserve_time: 24,
        ping_record_preserve_time: 24,
      }
    }
    const config = getCachedSiteConfig()
    if (config && !isEnabledValue(config.is_public)) {
      this.terminalFailure = true
      this.closeSocket()
      window.location.href = buildAdminUrl()
    }
  }

  private handleOnline = (): void => {
    if (this.destroyed || !this.stopRouteWatch || this.wsTimedOut || this.pausedForBackground || this.terminalFailure || document.hidden)
      return
    if (this.reconnectTimer !== undefined || this.socket?.readyState !== WebSocket.OPEN) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      void this.refreshPage(0, true).catch(error => console.error('[Live] Online reconnect failed:', error))
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    socket?.close()
    clearTimeout(this.socketStableTimer)
    this.socketStableTimer = undefined
    clearTimeout(this.wsTimeoutTimer)
    this.wsTimeoutTimer = undefined
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectAttempts = 0
    this.flushPendingStatuses()
  }

  destroy(): void {
    this.destroyed = true
    this.revision++
    setUnauthorizedHandler(null)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('online', this.handleOnline)
    this.clearBackgroundDisconnectTimer()
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
