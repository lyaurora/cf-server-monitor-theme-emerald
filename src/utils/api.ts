import type { CurrencyCode } from '@/utils/financeHelper'
import type { Client, NodeStatus, NodeStatusPing, PingRecord, PingWindowPoint, StatusRecord, TrafficLimitType } from '@/utils/rpc'
import { isSupportedCurrency, normalizedCurrencyMap } from '@/utils/financeHelper'
import { requestTurnstileToken } from '@/utils/turnstile'

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000
const MB = 1024 * 1024
const LEADING_SLASHES_REGEX = /^\/+/
const PRICE_NUMBER_REGEX = /-?[\d.,]+/
const BILLING_CYCLE_SUFFIX_REGEX = /\/\s*(?:(\d+(?:\.\d+)?)\s*)?(d(?:ay)?s?|m(?:onth)?s?|q(?:uarter)?s?|y(?:ear)?s?)\s*$/i
const FREE_PRICE_REGEX = /^(?:free|免费)$/i
const ONCE_BILLING_REGEX = /^(?:once|one[-_\s]?time|一次性?)$/i
const COMPACT_BILLING_REGEX = /(?:^|\/)\s*(?:(\d+(?:\.\d+)?)\s*)?([dmqy]|day|days|mo|month|months|quarter|quarters|yr|year|years)\s*$/i
const FIVE_YEAR_REGEX = /五年|5\s*(?:years?|yrs?|y)/i
const FOUR_YEAR_REGEX = /四年|4\s*(?:years?|yrs?|y)/i
const THREE_YEAR_REGEX = /三年|3\s*(?:years?|yrs?|y)/i
const TWO_YEAR_REGEX = /两年|二年|2\s*(?:years?|yrs?|y)/i
const HALF_YEAR_REGEX = /半年|half[-_\s]?year/i
const QUARTER_REGEX = /季|quarter/i
const YEAR_REGEX = /年|annual|year|yr\b/i
const MONTH_REGEX = /月|monthly|month|mo\b/i
const NUMERIC_BILLING_REGEX = /^-?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/
const WHITESPACE_REGEX = /\s+/

/**
 * `/api/servers` has used two billing contracts over its lifetime:
 *
 * - legacy versions put the amount, currency and cycle in one free-form
 *   `price` string (for example `￥30/月` or `$60/3Y`);
 * - current versions expose a normalized amount plus `billing_cycle` and
 *   `currency` fields.
 *
 * The UI keeps a day-based cycle internally, so the current enum values are
 * mapped here once at the HTTP adaptation boundary.
 */
const BILLING_CYCLE_DAYS = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  two_years: 730,
  three_years: 1095,
  four_years: 1460,
  five_years: 1825,
} as const

type BillingCycleKey = keyof typeof BILLING_CYCLE_DAYS

const BILLING_CYCLE_ALIASES: Record<string, BillingCycleKey> = {
  '月': 'month',
  'monthly': 'month',
  'month': 'month',
  'mo': 'month',
  '季': 'quarter',
  '季度': 'quarter',
  'quarterly': 'quarter',
  'quarter': 'quarter',
  '半年': 'half_year',
  'halfyear': 'half_year',
  'half_year': 'half_year',
  'half-year': 'half_year',
  'halfyearly': 'half_year',
  'half-yearly': 'half_year',
  '年': 'year',
  '一年': 'year',
  'annual': 'year',
  'yearly': 'year',
  'year': 'year',
  '两年': 'two_years',
  '二年': 'two_years',
  'two_years': 'two_years',
  'two-years': 'two_years',
  '2 years': 'two_years',
  '三年': 'three_years',
  'three_years': 'three_years',
  'three-years': 'three_years',
  '3 years': 'three_years',
  '四年': 'four_years',
  'four_years': 'four_years',
  'four-years': 'four_years',
  '4 years': 'four_years',
  '五年': 'five_years',
  'five_years': 'five_years',
  'five-years': 'five_years',
  '5 years': 'five_years',
}

export interface SiteConfig {
  version: string
  last_workers_version?: string | null
  last_agent_version?: string | null
  is_public: boolean | string
  authorization: boolean
  turnstile_enabled: boolean | string
  turnstile_login_enabled?: boolean | string
  turnstile_site_key?: string
  site_title?: string
  verified?: boolean
  turnstile_verified?: string | null
  theme_options?: unknown
  /** 延迟窗口配置：points 是最多真实点数，hours 是回看时长，不保证等间隔。 */
  latency_window?: {
    points?: number
    hours?: number
  }
  /** 自定义 Ping 运营商名称（旧版后端不返回时回退默认名称） */
  custom_ct_name?: string
  custom_cu_name?: string
  custom_cm_name?: string
  custom_bd_name?: string
  /** 详情页自定义节点名称（旧版后端不返回时回退默认名称） */
  node_1_name?: string
  node_2_name?: string
  node_3_name?: string
  node_4_name?: string
}

export interface SysConfig {
  long_history_points?: number
  show_price?: boolean
  show_expire?: boolean
  show_tf?: boolean
  show_time?: boolean
  /** 后端开关：是否在 /api/servers 输出 ping/loss 窗口；关闭时隐藏首页小图。 */
  show_three_net_details?: boolean
}

/** 真实时间的窗口采样点；false=未配置/未采样，RTT null=超时，loss null=无丢包样本。 */
export interface LatencyWindowPoint {
  ts?: number | string
  ct?: number | string | boolean | null
  cu?: number | string | boolean | null
  cm?: number | string | boolean | null
  bd?: number | string | boolean | null
  node_1?: number | string | boolean | null
  node_2?: number | string | boolean | null
  node_3?: number | string | boolean | null
  node_4?: number | string | boolean | null
}

export interface CfServer {
  id: string
  name?: string
  server_group?: string
  tags?: string
  price?: string | number | null
  billing_cycle?: string | number | null
  auto_renewal?: boolean | string | number | null
  currency?: string | null
  expire_date?: string | null
  expired_at?: string | null
  traffic_limit?: string | number
  traffic_calc_type?: string
  reset_day?: number
  report_interval?: number
  sort_order?: number
  cpu?: number | string
  load_avg?: string
  net_in_speed?: number | string
  net_out_speed?: number | string
  net_rx?: number | string
  net_tx?: number | string
  net_rx_monthly?: number | string
  net_tx_monthly?: number | string
  processes?: number | string
  tcp_conn?: number | string
  udp_conn?: number | string
  ping_ct?: number | string | false | null
  ping_cu?: number | string | false | null
  ping_cm?: number | string | false | null
  ping_bd?: number | string | false | null
  loss_ct?: number | string | false | null
  loss_cu?: number | string | false | null
  loss_cm?: number | string | false | null
  loss_bd?: number | string | false | null
  ping_node_1?: number | string | false | null
  ping_node_2?: number | string | false | null
  ping_node_3?: number | string | false | null
  ping_node_4?: number | string | false | null
  loss_node_1?: number | string | false | null
  loss_node_2?: number | string | false | null
  loss_node_3?: number | string | false | null
  loss_node_4?: number | string | false | null
  /** 延迟窗口（旧→新，最多点数与时长由 latency_window 决定），仅 /api/servers 列表返回。 */
  ping?: LatencyWindowPoint[]
  loss?: LatencyWindowPoint[]
  ram_total?: number | string
  ram_used?: number | string
  swap_total?: number | string
  swap_used?: number | string
  disk_total?: number | string
  disk_used?: number | string
  cpu_cores?: number | string
  cpu_info?: string
  gpu?: number | string | null
  gpu_info?: string | unknown[]
  arch?: string
  os?: string
  region?: string
  boot_time?: string | number
  kernel_version?: string
  last_updated?: number | string
  timestamp?: number | string
  is_online?: boolean
  sysConfig?: SysConfig
  latestReportUpdates?: LatestReportUpdate[]
}

export interface LatestReportSample {
  ts?: number | string
  payload?: Record<string, unknown>
  data?: Record<string, unknown>
  metrics?: Record<string, unknown>
}

export interface LatestReportUpdate {
  serverId: string
  reportTs?: number | string
  samples?: LatestReportSample[]
  reportAgeMs?: number
}

export interface ServersResponse {
  servers: CfServer[]
  latestReportUpdates?: LatestReportUpdate[]
  stats?: Record<string, unknown>
  regionStats?: Record<string, unknown>
  sysConfig?: SysConfig
}

export type ThemeMode = 'auto' | 'light' | 'dark'
export type NodeViewMode = 'card' | 'list'
export type EarthViewMode = 'earth' | 'earth-stop' | 'maps' | 'cards' | 'hide'
export type BackgroundType = 'image' | 'video'

export interface ThemeSettings {
  pingLinesByNode: Record<string, string[]>
  defaultThemeMode: ThemeMode
  defaultViewMode: NodeViewMode
  alertEnabled: boolean
  alertTitle: string
  alertContent: string
  earthViewMode: EarthViewMode
  visitorInfoCardEnabled: boolean
  hideAdminEntryWhenLoggedOut: boolean
  disablePageAnimation: boolean
  offlineNodesLast: boolean
  icpEnabled: boolean
  icpNumber: string
  icpUrl: string
  policeEnabled: boolean
  policeNumber: string
  policeUrl: string
  backgroundEnabled: boolean
  backgroundType: BackgroundType
  lightBackgroundUrl: string
  darkBackgroundUrl: string
  backgroundBlur: number
  backgroundOverlay: number
}

export interface PublicSettings {
  ping_record_preserve_time: number
  record_preserve_time: number
  sitename: string
  themeSettings: ThemeSettings
}

export interface VersionInfo {
  hash: string
  version: string
}

interface HistoryRow extends Record<string, unknown> {
  timestamp: number | string
}

interface AdaptedServer {
  client: Client
  status: NodeStatus
}

export class ApiError extends Error {
  code?: number

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

let cachedSysConfig: SysConfig | undefined
let cachedSiteConfig: SiteConfig | undefined

type PingProviderKey = 'ct' | 'cu' | 'cm' | 'bd'
type PingNodeKey = 'node_1' | 'node_2' | 'node_3' | 'node_4'
type PingTaskKey = PingProviderKey | PingNodeKey

const DEFAULT_PING_TASK_NAMES: Record<PingTaskKey, string> = {
  ct: '电信',
  cu: '联通',
  cm: '移动',
  bd: 'BGP',
  node_1: '节点 1',
  node_2: '节点 2',
  node_3: '节点 3',
  node_4: '节点 4',
}

/** Ping 显示名称，由 /api/config 的自定义名称覆盖，未配置时为默认值 */
let pingTaskNames: Record<PingTaskKey, string> = { ...DEFAULT_PING_TASK_NAMES }

/** /api/config 未返回自定义名称或返回空值时逐项回退默认名称，兼容旧版后端 */
function applyCustomPingNames(config?: SiteConfig): void {
  if (!config)
    return
  pingTaskNames = {
    ...DEFAULT_PING_TASK_NAMES,
    ct: config.custom_ct_name?.trim() || DEFAULT_PING_TASK_NAMES.ct,
    cu: config.custom_cu_name?.trim() || DEFAULT_PING_TASK_NAMES.cu,
    cm: config.custom_cm_name?.trim() || DEFAULT_PING_TASK_NAMES.cm,
    bd: config.custom_bd_name?.trim() || DEFAULT_PING_TASK_NAMES.bd,
    node_1: config.node_1_name?.trim() || DEFAULT_PING_TASK_NAMES.node_1,
    node_2: config.node_2_name?.trim() || DEFAULT_PING_TASK_NAMES.node_2,
    node_3: config.node_3_name?.trim() || DEFAULT_PING_TASK_NAMES.node_3,
    node_4: config.node_4_name?.trim() || DEFAULT_PING_TASK_NAMES.node_4,
  }
}

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  pingLinesByNode: {},
  defaultViewMode: 'card',
  defaultThemeMode: 'auto',
  alertEnabled: false,
  alertTitle: '',
  alertContent: '',
  earthViewMode: 'earth',
  visitorInfoCardEnabled: true,
  hideAdminEntryWhenLoggedOut: false,
  disablePageAnimation: false,
  offlineNodesLast: false,
  icpEnabled: false,
  icpNumber: '',
  icpUrl: 'https://beian.miit.gov.cn/',
  policeEnabled: false,
  policeNumber: '',
  policeUrl: '',
  backgroundEnabled: false,
  backgroundType: 'image',
  lightBackgroundUrl: '',
  darkBackgroundUrl: '',
  backgroundBlur: 0,
  backgroundOverlay: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function themeOptionValues(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    return {}

  const values: Record<string, unknown> = {}
  const configuration = value.configuration
  if (Array.isArray(configuration)) {
    for (const item of configuration) {
      if (!isRecord(item) || typeof item.key !== 'string')
        continue
      values[item.key] = item.value
    }
  }

  for (const [key, optionValue] of Object.entries(value)) {
    if (key !== 'configuration')
      values[key] = optionValue
  }
  return values
}

export function normalizePingLinesByNode(value: unknown): Record<string, string[]> {
  if (!isRecord(value))
    return {}
  return Object.fromEntries(Object.entries(value).flatMap(([uuid, lines]) => {
    if (!Array.isArray(lines))
      return []
    const valid = [...new Set(lines.filter((key): key is string => typeof key === 'string' && Object.hasOwn(DEFAULT_PING_TASK_NAMES, key)))].slice(0, 3)
    return valid.length ? [[uuid, valid]] : []
  }))
}

export function resolvePingLines(available: string[], saved: string[] = []): string[] {
  return [...new Set([...saved.filter(key => available.includes(key)), ...available])].slice(0, 3)
}

export function switchPingLine(lines: string[], index: number, key: string): string[] {
  const next = [...lines]
  if (index < 0 || index >= lines.length)
    return next
  const other = next.indexOf(key)
  if (other >= 0)
    next[other] = next[index]!
  next[index] = key
  return next
}

function themeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean')
    return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true')
      return true
    if (value.toLowerCase() === 'false')
      return false
  }
  return fallback
}

function themeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function themeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback
}

function themeEnum<T extends string>(value: unknown, fallback: T, values: readonly T[]): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback
}

/** Converts the CF Server Monitor `theme_options` wire format to UI-safe values. */
export function adaptThemeOptions(value: unknown): ThemeSettings {
  const options = themeOptionValues(value)
  return {
    pingLinesByNode: normalizePingLinesByNode(options.pingLinesByNode),
    defaultViewMode: themeEnum(options.defaultViewMode, DEFAULT_THEME_SETTINGS.defaultViewMode, ['card', 'list']),
    defaultThemeMode: themeEnum(options.defaultThemeMode, DEFAULT_THEME_SETTINGS.defaultThemeMode, ['auto', 'light', 'dark']),
    alertEnabled: themeBoolean(options.alertEnabled, DEFAULT_THEME_SETTINGS.alertEnabled),
    alertTitle: themeString(options.alertTitle, DEFAULT_THEME_SETTINGS.alertTitle),
    alertContent: themeString(options.alertContent, DEFAULT_THEME_SETTINGS.alertContent),
    earthViewMode: themeEnum(options.earthViewMode, DEFAULT_THEME_SETTINGS.earthViewMode, ['earth', 'earth-stop', 'maps', 'cards', 'hide']),
    visitorInfoCardEnabled: themeBoolean(options.visitorInfoCardEnabled, DEFAULT_THEME_SETTINGS.visitorInfoCardEnabled),
    hideAdminEntryWhenLoggedOut: themeBoolean(options.hideAdminEntryWhenLoggedOut, DEFAULT_THEME_SETTINGS.hideAdminEntryWhenLoggedOut),
    disablePageAnimation: themeBoolean(options.disablePageAnimation, DEFAULT_THEME_SETTINGS.disablePageAnimation),
    offlineNodesLast: themeBoolean(options.offlineNodesLast, DEFAULT_THEME_SETTINGS.offlineNodesLast),
    icpEnabled: themeBoolean(options.icpEnabled, DEFAULT_THEME_SETTINGS.icpEnabled),
    icpNumber: themeString(options.icpNumber, DEFAULT_THEME_SETTINGS.icpNumber),
    icpUrl: themeString(options.icpUrl, DEFAULT_THEME_SETTINGS.icpUrl),
    policeEnabled: themeBoolean(options.policeEnabled, DEFAULT_THEME_SETTINGS.policeEnabled),
    policeNumber: themeString(options.policeNumber, DEFAULT_THEME_SETTINGS.policeNumber),
    policeUrl: themeString(options.policeUrl, DEFAULT_THEME_SETTINGS.policeUrl),
    backgroundEnabled: themeBoolean(options.backgroundEnabled, DEFAULT_THEME_SETTINGS.backgroundEnabled),
    backgroundType: themeEnum(options.backgroundType, DEFAULT_THEME_SETTINGS.backgroundType, ['image', 'video']),
    lightBackgroundUrl: themeString(options.lightBackgroundUrl, DEFAULT_THEME_SETTINGS.lightBackgroundUrl),
    darkBackgroundUrl: themeString(options.darkBackgroundUrl, DEFAULT_THEME_SETTINGS.darkBackgroundUrl),
    backgroundBlur: themeNumber(options.backgroundBlur, DEFAULT_THEME_SETTINGS.backgroundBlur, 0, 100),
    backgroundOverlay: themeNumber(options.backgroundOverlay, DEFAULT_THEME_SETTINGS.backgroundOverlay, -100, 100),
  }
}

function finiteNumber(value: unknown): number {
  const number = Number.parseFloat(String(value ?? 0))
  return Number.isFinite(number) ? number : 0
}

function parseGpuInfo(raw: unknown): Array<{ id?: number | string, name?: string, info?: string }> {
  if (!raw)
    return []
  if (Array.isArray(raw))
    return raw as Array<{ id?: number | string, name?: string, info?: string }>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    }
    catch { return [] }
  }
  return []
}

function getGpuName(raw: unknown): string {
  const list = parseGpuInfo(raw)
  if (list.length > 0)
    return list.map(g => g.name || g.id || 'GPU').join(' / ')
  return String(raw ?? '')
}

function normalizeGpuInfo(raw: unknown): string {
  if (!raw)
    return ''
  if (typeof raw === 'string') {
    if (raw.startsWith('[') || raw.startsWith('{'))
      return raw
    return JSON.stringify([{ name: raw }])
  }
  if (Array.isArray(raw))
    return JSON.stringify(raw)
  return String(raw)
}

function numberField(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '')
      return finiteNumber(value)
  }
  return 0
}

function timestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value !== 'number' && typeof value !== 'string')
    return fallback
  const number = finiteNumber(value)
  if (!number)
    return fallback
  return number < 1e12 ? number * 1000 : number
}

export function getApiAssetUrl(path: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/${path.replace(LEADING_SLASHES_REGEX, '')}`
}

function getLocalStorageValue(key: string): string {
  if (typeof localStorage === 'undefined')
    return ''

  try {
    return localStorage.getItem(key)?.trim() ?? ''
  }
  catch {
    return ''
  }
}

function authHeaders(initialHeaders?: HeadersInit): Headers {
  const headers = new Headers(initialHeaders)
  const token = getLocalStorageValue('jwt_token')
  if (token)
    headers.set('Authorization', `Bearer ${token}`)

  const host = typeof window === 'undefined' ? '' : window.location.hostname
  const turnstileToken = getLocalStorageValue('turnstile_token')
  const verified = (host ? getLocalStorageValue(`turnstile_verified_${host}`) : '') || getLocalStorageValue('turnstile_verified')
  if (turnstileToken)
    headers.set('X-Turnstile-Token', turnstileToken)
  else if (verified)
    headers.set('X-Turnstile-Verified', verified)
  return headers
}

function clearTurnstileSession(): void {
  try {
    const host = window.location.hostname
    localStorage.removeItem(`turnstile_verified_${host}`)
    localStorage.removeItem('turnstile_verified')
    localStorage.removeItem('turnstile_token')
  }
  catch {}
}

function storeTurnstileVerified(verified: string): void {
  const host = window.location.hostname
  localStorage.setItem(`turnstile_verified_${host}`, verified)
  localStorage.setItem('turnstile_verified', verified)
  localStorage.removeItem('turnstile_token')
}

/** 并发 403 共享同一次重新验证，避免一次性 token 被重复消费。 */
let turnstileRefreshPromise: Promise<boolean> | null = null
let turnstileRefreshRevision = 0

async function resolveTurnstileSiteKey(): Promise<string | null> {
  const cached = cachedSiteConfig
  if (cached && enabled(cached.turnstile_enabled) && cached.turnstile_site_key)
    return cached.turnstile_site_key

  // Cold start：本地 verified 已过期被清掉后，裸请求拿 site key（不带 Turnstile 头）
  try {
    const response = await fetch('/api/config')
    if (!response.ok)
      return null
    const data = await response.json() as SiteConfig
    if (!enabled(data.turnstile_enabled) || !data.turnstile_site_key)
      return null
    cachedSiteConfig = data
    return data.turnstile_site_key
  }
  catch {
    return null
  }
}

/**
 * Turnstile verified 失效后：弹窗重新验证，用 token 换新的 verified，再让调用方重试原请求。
 */
async function refreshTurnstileSession(): Promise<boolean> {
  if (turnstileRefreshPromise)
    return turnstileRefreshPromise

  turnstileRefreshRevision++
  turnstileRefreshPromise = (async () => {
    const siteKey = await resolveTurnstileSiteKey()
    if (!siteKey)
      return false

    let token = ''
    try {
      token = await requestTurnstileToken(siteKey)
      localStorage.setItem('turnstile_token', token)
      // allowRetry=false：换票本身失败时不再嵌套弹窗
      await request('/api/config', {}, false)
      return true
    }
    catch {
      if (token && getLocalStorageValue('turnstile_token') === token)
        clearTurnstileSession()
      return false
    }
  })().finally(() => {
    turnstileRefreshPromise = null
  })

  return turnstileRefreshPromise
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  allowTurnstileRetry = true,
): Promise<T> {
  if (allowTurnstileRetry && turnstileRefreshPromise && !await turnstileRefreshPromise)
    throw new ApiError('Turnstile 验证失败', 403)

  const requestAuthRevision = turnstileRefreshRevision
  const requestHeaders = authHeaders(options.headers)
  const response = await fetch(path, {
    ...options,
    headers: requestHeaders,
  })

  let data: unknown
  try {
    data = await response.json()
  }
  catch {
    data = null
  }

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : `HTTP ${response.status}`
    if (response.status === 403) {
      // Wait for the in-flight exchange; its token must only be consumed once.
      if (allowTurnstileRetry && turnstileRefreshPromise) {
        if (await turnstileRefreshPromise)
          return request(path, options, false)
      }
      else {
        const currentHeaders = authHeaders(options.headers)
        const credentialsChanged = ['X-Turnstile-Token', 'X-Turnstile-Verified'].some(name =>
          currentHeaders.has(name) && currentHeaders.get(name) !== requestHeaders.get(name),
        )
        // An old response must not restart a verification round that already failed.
        if (!credentialsChanged && requestAuthRevision !== turnstileRefreshRevision)
          throw new ApiError(message, response.status)
        // A late failure from an old session must not clear the new session.
        if (!credentialsChanged)
          clearTurnstileSession()
        if (allowTurnstileRetry && (credentialsChanged || await refreshTurnstileSession()))
          return request(path, options, false)
      }
    }
    throw new ApiError(message, response.status)
  }

  if (data && typeof data === 'object' && 'turnstile_verified' in data) {
    const verified = String((data as { turnstile_verified?: unknown }).turnstile_verified || '')
    if (verified)
      storeTurnstileVerified(verified)
  }
  return data as T
}

export async function fetchSiteConfig(): Promise<SiteConfig> {
  const config = await request<SiteConfig>('/api/config')
  cachedSiteConfig = config
  applyCustomPingNames(config)
  return config
}

// Keep acknowledged edits while other Worker instances can still return cached configuration.
const savedPingLineEdits = new Map<string, { time: number, lines: string[] }>()

export async function saveNodePingLines(uuid: string, lines: string[]): Promise<Record<string, string[]>> {
  if (lines.length > 3 || lines.some(key => !Object.hasOwn(DEFAULT_PING_TASK_NAMES, key)) || new Set(lines).size !== lines.length)
    throw new Error('无效的探针线路')
  const config = await request<SiteConfig>('/api/config')
  if (!config.authorization)
    throw new Error('请先登录站长账号')
  const existing = isRecord(config.theme_options) ? config.theme_options : {}
  const recentEdits = Object.fromEntries([...savedPingLineEdits]
    .filter(([, edit]) => Date.now() - edit.time < 150_000)
    .map(([key, edit]) => [key, edit.lines]))
  const pingLinesByNode = { ...adaptThemeOptions(existing).pingLinesByNode, ...recentEdits, [uuid]: lines }
  const themeOptions = { ...existing, pingLinesByNode }
  const result = await request<{ success: boolean, message?: string }>('/api/theme_options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_options: themeOptions }),
  })
  if (!result?.success)
    throw new Error(result?.message || '线路配置保存失败')
  savedPingLineEdits.set(uuid, { time: Date.now(), lines })
  cachedSiteConfig = { ...config, theme_options: themeOptions }
  return normalizePingLinesByNode(pingLinesByNode)
}

export interface AdaptedServerBilling {
  price: number
  priceConfigured: boolean
  billingCycle: number
  currency: string
  autoRenewal: boolean
}

function parsePriceAmount(value: unknown): { price: number, configured: boolean } {
  const text = String(value ?? '').trim()
  if (!text)
    return { price: 0, configured: false }

  if (FREE_PRICE_REGEX.test(text))
    return { price: -1, configured: true }

  // Only the part before the slash is the amount: "$60/3Y" must be 60, not 603.
  const amountText = text.split('/', 1)[0]?.match(PRICE_NUMBER_REGEX)?.[0]
  if (!amountText)
    return { price: 0, configured: false }

  const price = Number.parseFloat(amountText.replaceAll(',', ''))
  if (!Number.isFinite(price) || (price < 0 && price !== -1))
    return { price: 0, configured: false }

  return { price, configured: true }
}

function parseBillingCycleSuffix(countText: string | undefined, unit: string): number {
  const count = Number(countText || 1)
  const normalizedUnit = unit.toLowerCase()

  if (normalizedUnit.startsWith('y'))
    return count * 365
  if (normalizedUnit.startsWith('q'))
    return count * 90
  if (normalizedUnit.startsWith('m'))
    return count * 30
  return count
}

function parseBillingCycle(value: unknown): number | null {
  if (value === undefined || value === null || value === '')
    return null

  if (typeof value === 'number')
    return Number.isFinite(value) ? value : null

  const text = String(value).trim()
  if (!text)
    return null

  const numericCycle = Number(text)
  if (Number.isFinite(numericCycle))
    return numericCycle

  const normalized = text.toLowerCase().replaceAll(' ', '_')
  const aliasedCycle = BILLING_CYCLE_ALIASES[normalized] ?? BILLING_CYCLE_ALIASES[text.toLowerCase()]
  if (aliasedCycle)
    return BILLING_CYCLE_DAYS[aliasedCycle]

  if (ONCE_BILLING_REGEX.test(text))
    return -1

  const cycleSuffix = text.match(BILLING_CYCLE_SUFFIX_REGEX)
  if (cycleSuffix)
    return parseBillingCycleSuffix(cycleSuffix[1], cycleSuffix[2] ?? '')

  const compactCycle = text.match(COMPACT_BILLING_REGEX)
  if (compactCycle)
    return parseBillingCycleSuffix(compactCycle[1], compactCycle[2] ?? '')

  if (FIVE_YEAR_REGEX.test(text))
    return BILLING_CYCLE_DAYS.five_years
  if (FOUR_YEAR_REGEX.test(text))
    return BILLING_CYCLE_DAYS.four_years
  if (THREE_YEAR_REGEX.test(text))
    return BILLING_CYCLE_DAYS.three_years
  if (TWO_YEAR_REGEX.test(text))
    return BILLING_CYCLE_DAYS.two_years
  if (HALF_YEAR_REGEX.test(text))
    return BILLING_CYCLE_DAYS.half_year
  if (QUARTER_REGEX.test(text))
    return BILLING_CYCLE_DAYS.quarter
  if (YEAR_REGEX.test(text))
    return BILLING_CYCLE_DAYS.year
  if (MONTH_REGEX.test(text))
    return BILLING_CYCLE_DAYS.month

  return null
}

function normalizeCurrencyField(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw)
    return null

  const upper = raw.toUpperCase()
  return normalizedCurrencyMap[raw]
    ?? normalizedCurrencyMap[upper]
    ?? (isSupportedCurrency(upper) ? upper : null)
}

const ISO_CURRENCY_CODE_REGEX = /^[A-Z]{3}$/i

/** symbol → ISO code（排除 ISO 代码键，按长度降序匹配） */
const REVERSE_SYMBOL_MAP: Record<string, CurrencyCode> = Object.fromEntries(
  Object.entries(normalizedCurrencyMap)
    .filter(([k]) => !ISO_CURRENCY_CODE_REGEX.test(k))
    .map(([symbol, code]) => [symbol, code]),
)
const SORTED_SYMBOL_KEYS = Object.keys(REVERSE_SYMBOL_MAP).sort((a, b) => b.length - a.length)

function detectLegacyCurrency(value: unknown): string {
  const text = String(value ?? '')
  if (!text)
    return 'CNY'

  const upper = text.toUpperCase()

  // 按长度降序匹配符号，确保 "HK$" 优先于 "$"
  for (const symbol of SORTED_SYMBOL_KEYS) {
    if (text.includes(symbol) || (symbol.length > 1 && upper.includes(symbol.toUpperCase())))
      return REVERSE_SYMBOL_MAP[symbol]!
  }

  // 尝试 ISO 代码匹配
  for (const [key, code] of Object.entries(normalizedCurrencyMap)) {
    if (ISO_CURRENCY_CODE_REGEX.test(key) && upper.includes(key))
      return code
  }

  return 'CNY'
}

function parseLegacyBillingCycle(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (!text)
    return null

  // A current API amount such as "30.00" is not itself a billing cycle.
  if (NUMERIC_BILLING_REGEX.test(text))
    return null

  return parseBillingCycle(text)
}

/** Normalizes both current and legacy CF Server Monitor billing fields. */
export function adaptServerBilling(server: Pick<CfServer, 'price' | 'billing_cycle' | 'currency' | 'auto_renewal'>): AdaptedServerBilling {
  const parsedPrice = parsePriceAmount(server.price)
  const legacyBillingCycle = parseLegacyBillingCycle(server.price) ?? BILLING_CYCLE_DAYS.month
  const explicitBillingCycle = parseBillingCycle(server.billing_cycle)

  return {
    price: parsedPrice.price,
    priceConfigured: parsedPrice.configured,
    billingCycle: explicitBillingCycle ?? legacyBillingCycle,
    currency: resolveDisplayCurrency(server),
    autoRenewal: enabled(server.auto_renewal),
  }
}

/**
 * Keep the API `currency` wire value for display (e.g. `¥JPY`).
 * Finance math still goes through `normalizeCurrency()` → ISO codes.
 */
function resolveDisplayCurrency(server: Pick<CfServer, 'price' | 'currency'>): string {
  const raw = String(server.currency ?? '').trim()
  const normalized = raw === '￥' ? '¥' : raw
  if (normalized) {
    const upper = normalized.toUpperCase()
    if (normalizeCurrencyField(normalized) || isSupportedCurrency(upper))
      return normalized
  }

  return detectLegacyCurrency(server.price)
}

function parseTrafficLimit(value: unknown): number {
  const text = String(value ?? '').trim().toUpperCase()
  const amount = finiteNumber(text)
  if (!amount)
    return 0
  if (text.includes('PB'))
    return amount * 1024 ** 5
  if (text.includes('TB'))
    return amount * 1024 ** 4
  if (text.includes('MB'))
    return amount * 1024 ** 2
  if (text.includes('KB'))
    return amount * 1024
  return amount * 1024 ** 3
}

function trafficLimitType(value: unknown): TrafficLimitType {
  const type = String(value ?? '').toLowerCase()
  if (type === 'dl' || type === 'down')
    return 'down'
  if (type === 'ul' || type === 'up')
    return 'up'
  if (type === 'min' || type === 'max')
    return type
  return 'sum'
}

function pingEntry(name: string, latency: unknown, loss: unknown): NodeStatusPing {
  const lossValue = nullableNumber(loss) ?? Number.NaN
  // Keep explicit timeouts distinct from absent/disabled probe fields.
  const latest = latency === null || lossValue === 100 ? -1 : nullableNumber(latency) ?? Number.NaN
  return { name, latest, loss: lossValue }
}

interface PingTaskDefinition {
  id: number
  key: PingTaskKey
  latencyField: keyof CfServer
  lossField: keyof CfServer
}

const PING_TASKS: PingTaskDefinition[] = [
  { id: 1, key: 'ct', latencyField: 'ping_ct', lossField: 'loss_ct' },
  { id: 2, key: 'cu', latencyField: 'ping_cu', lossField: 'loss_cu' },
  { id: 3, key: 'cm', latencyField: 'ping_cm', lossField: 'loss_cm' },
  { id: 4, key: 'bd', latencyField: 'ping_bd', lossField: 'loss_bd' },
  { id: 5, key: 'node_1', latencyField: 'ping_node_1', lossField: 'loss_node_1' },
  { id: 6, key: 'node_2', latencyField: 'ping_node_2', lossField: 'loss_node_2' },
  { id: 7, key: 'node_3', latencyField: 'ping_node_3', lossField: 'loss_node_3' },
  { id: 8, key: 'node_4', latencyField: 'ping_node_4', lossField: 'loss_node_4' },
]

/**
 * null 是明确超时；false/缺失才是未配置或未取样。数值 0 保持有效。
 */
function isPingFieldPresent(value: unknown): boolean {
  return value === null || nullableNumber(value) !== null
}

function pingFieldPresent(server: CfServer, field: keyof CfServer): boolean {
  return isPingFieldPresent(server[field])
}

export function mergeServerPingSample(server: Record<string, unknown>, previous: NodeStatus['ping']): NodeStatus['ping'] {
  let ping = previous
  for (const task of PING_TASKS) {
    const hasLatency = Object.hasOwn(server, task.latencyField)
    const hasLoss = Object.hasOwn(server, task.lossField)
    if (!hasLatency && !hasLoss)
      continue
    const current = previous?.[task.key]
    const latency = hasLatency ? server[task.latencyField] : current?.latest
    const loss = hasLoss ? server[task.lossField] : current?.loss
    const next = isPingFieldPresent(latency) || isPingFieldPresent(loss)
      ? pingEntry(pingTaskNames[task.key], latency, loss)
      : undefined
    if (next ? current && Object.entries(next).every(([field, value]) => Object.is(value, current[field as keyof NodeStatusPing])) : !current)
      continue
    if (ping === previous)
      ping = { ...previous }
    if (next)
      ping![task.key] = next
    else
      delete ping![task.key]
  }
  return ping
}

function nullableNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string')
    return null
  if (String(value).trim() === '')
    return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function optionalMegabytes(value: unknown): number | null {
  const bytes = (nullableNumber(value) ?? -1) * MB
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
}

function buildPingWindowPoint(
  ts: number,
  pingPoint: LatencyWindowPoint | undefined,
  lossPoint: LatencyWindowPoint | undefined,
): PingWindowPoint {
  const lines = Object.fromEntries(PING_TASKS.map(({ key }) => {
    const latency = nullableNumber(pingPoint?.[key])
    const loss = nullableNumber(lossPoint?.[key])
    return [key, {
      latency: latency !== null && latency >= 0 && loss !== 100 ? latency : null,
      loss: loss !== null && loss >= 0 && loss <= 100 ? loss : latency !== null && latency < 0 ? 100 : null,
    }]
  }))
  return {
    time: new Date(ts).toISOString(),
    lines,
  }
}

/** 将 /api/servers 的 ping/loss 窗口（旧→新）按时间戳对齐聚合成延迟/丢包点 */
function buildPingWindow(server: CfServer): PingWindowPoint[] | undefined {
  const ping = Array.isArray(server.ping) ? server.ping : undefined
  const loss = Array.isArray(server.loss) ? server.loss : undefined
  if (!ping?.length && !loss?.length)
    return undefined

  const byTime = (items: LatencyWindowPoint[]) => new Map(items
    .map(point => [timestamp(point.ts, 0), point] as const)
    .filter(([ts]) => ts > 0 && Number.isFinite(ts)))
  const pingByTs = byTime(ping ?? [])
  const lossByTs = byTime(loss ?? [])
  const points = [...new Set([...pingByTs.keys(), ...lossByTs.keys()])]
    .sort((a, b) => a - b)
    .map(ts => buildPingWindowPoint(ts, pingByTs.get(ts), lossByTs.get(ts)))

  return points.length ? points : undefined
}

export function adaptServer(server: CfServer, sysConfig: SysConfig | undefined = server.sysConfig): AdaptedServer {
  const wire = server as unknown as Record<string, unknown>
  const uuid = server.id

  const billing = adaptServerBilling(server)
  const updatedAt = timestamp(wire.report_timestamp ?? server.last_updated ?? server.timestamp, 0)
  const now = Date.now()
  const bootTime = timestamp(server.boot_time, 0)
  const online = updatedAt > 0 && now - updatedAt < ONLINE_THRESHOLD_MS
  const pingWindow = buildPingWindow(server)
  const ping: Record<string, NodeStatusPing> = {}
  for (const task of PING_TASKS) {
    const hasCurrentFields = Object.hasOwn(server, task.latencyField) || Object.hasOwn(server, task.lossField)
    if (pingFieldPresent(server, task.latencyField) || pingFieldPresent(server, task.lossField)
      || (!hasCurrentFields && pingWindow?.some(point => point.lines?.[task.key]?.latency != null || point.lines?.[task.key]?.loss != null))) {
      ping[task.key] = pingEntry(
        pingTaskNames[task.key],
        server[task.latencyField],
        server[task.lossField],
      )
    }
  }

  return {
    client: {
      uuid,
      name: server.name || server.id,
      cpu_name: server.cpu_info || '-',
      kernel_version: server.kernel_version || '-',
      arch: server.arch || '-',
      cpu_cores: finiteNumber(server.cpu_cores),
      os: server.os || '-',
      boot_time: bootTime > 0 ? new Date(bootTime).toISOString() : '',
      gpu_name: getGpuName(server.gpu_info),
      gpu_info: normalizeGpuInfo(server.gpu_info),
      region: String(server.region || '').toUpperCase(),
      mem_total: finiteNumber(server.ram_total) * MB,
      swap_total: optionalMegabytes(server.swap_total),
      disk_total: finiteNumber(server.disk_total) * MB,
      weight: finiteNumber(server.sort_order),
      price: billing.price,
      price_configured: billing.priceConfigured,
      billing_cycle: billing.billingCycle,
      auto_renewal: billing.autoRenewal,
      currency: billing.currency,
      expired_at: server.expire_date || server.expired_at || '9999-12-31',
      group: server.server_group || '默认分组',
      tags: server.tags || '',
      showPrice: sysConfig?.show_price === undefined || enabled(sysConfig.show_price),
      showExpire: sysConfig?.show_expire === undefined || enabled(sysConfig.show_expire),
      showTraffic: sysConfig?.show_tf === undefined || enabled(sysConfig.show_tf),
      traffic_limit: parseTrafficLimit(server.traffic_limit),
      traffic_limit_type: trafficLimitType(server.traffic_calc_type),
    },
    status: {
      ...adaptStatusRecord(uuid, wire, updatedAt ? new Date(updatedAt).toISOString() : ''),
      online,
      uptime: bootTime > 0 ? Math.max(0, Math.floor((now - bootTime) / 1000)) : 0,
      ping,
      pingWindow,
    },
  }
}

export async function fetchAllServers(): Promise<{
  clients: Record<string, Client>
  statuses: Record<string, NodeStatus>
  latestReportUpdates: LatestReportUpdate[]
  sysConfig?: SysConfig
}> {
  const response = await request<ServersResponse>('/api/servers')
  if (response.sysConfig)
    cachedSysConfig = response.sysConfig
  const clients: Record<string, Client> = {}
  const statuses: Record<string, NodeStatus> = {}
  for (const server of response.servers ?? []) {
    const { client, status } = adaptServer(server, response.sysConfig)
    clients[client.uuid] = client
    statuses[client.uuid] = status
  }
  return { clients, statuses, latestReportUpdates: response.latestReportUpdates ?? [], sysConfig: response.sysConfig }
}

function adaptStatusRecord(uuid: string, row: Record<string, unknown>, time: string): StatusRecord {
  const load = String(row.load_avg ?? '').split(WHITESPACE_REGEX).map(finiteNumber)
  return {
    client: uuid,
    time,
    cpu: finiteNumber(row.cpu),
    gpu: finiteNumber(row.gpu),
    ram: finiteNumber(row.ram_used) * MB,
    ram_total: finiteNumber(row.ram_total) * MB,
    swap: optionalMegabytes(row.swap_used),
    swap_total: optionalMegabytes(row.swap_total),
    load: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
    temp: 0,
    disk: finiteNumber(row.disk_used) * MB,
    disk_total: finiteNumber(row.disk_total) * MB,
    net_in: numberField(row, 'net_in_speed', 'net_in'),
    net_out: numberField(row, 'net_out_speed', 'net_out'),
    net_total_up: numberField(row, 'net_tx', 'net_total_up', 'net_tx_monthly'),
    net_total_down: numberField(row, 'net_rx', 'net_total_down', 'net_rx_monthly'),
    net_monthly_up: numberField(row, 'net_tx_monthly', 'net_tx'),
    net_monthly_down: numberField(row, 'net_rx_monthly', 'net_rx'),
    process: finiteNumber(row.processes),
    connections: finiteNumber(row.tcp_conn),
    connections_udp: finiteNumber(row.udp_conn),
  }
}

// Share only in-flight requests; each chart keeps its own time range and fresh reloads.
const pendingHistory = new Map<string, Promise<HistoryRow[]>>()

export function invalidateHistoryRequests(): void {
  pendingHistory.clear()
}

function fetchHistoryRows(uuid: string, hours: number): Promise<HistoryRow[]> {
  const path = `/api/history/all?id=${encodeURIComponent(uuid)}&hours=${hours}`
  let pending = pendingHistory.get(path)
  if (!pending) {
    pending = request<HistoryRow[]>(path).finally(() => {
      if (pendingHistory.get(path) === pending)
        pendingHistory.delete(path)
    })
    pendingHistory.set(path, pending)
  }
  return pending
}

export async function fetchLoadHistory(uuid: string, hours = 1): Promise<StatusRecord[]> {
  const rows = await fetchHistoryRows(uuid, hours)
  return (rows ?? []).map(row => adaptStatusRecord(uuid, row, new Date(timestamp(row.timestamp)).toISOString()))
}

export async function fetchPingHistory(uuid: string, hours = 1): Promise<{
  records: PingRecord[]
  tasks: Array<{ id: number, key: PingTaskKey, name: string, interval: number, loss?: number }>
}> {
  const rows = await fetchHistoryRows(uuid, hours)
  const records: PingRecord[] = []
  const losses = new Map<number, number[]>()
  const availableTasks = new Set<number>()

  for (const row of rows ?? []) {
    const time = new Date(timestamp(row.timestamp)).toISOString()
    for (const task of PING_TASKS) {
      const latencyValue = row[task.latencyField]
      const lossRaw = row[task.lossField]
      const hasLatency = isPingFieldPresent(latencyValue)
      const hasLoss = isPingFieldPresent(lossRaw)
      // 保留 null 超时；两端均为 false/缺失时不生成记录。
      if (!hasLatency && !hasLoss)
        continue

      availableTasks.add(task.id)
      const lossValue = nullableNumber(lossRaw) ?? undefined
      const latency = nullableNumber(latencyValue)
      records.push({
        client: uuid,
        task_id: task.id,
        time,
        value: lossValue === 100 || latencyValue === null ? -1 : latency ?? Number.NaN,
        loss: lossValue,
      })
      if (lossValue !== undefined) {
        const taskLosses = losses.get(task.id) ?? []
        taskLosses.push(lossValue)
        losses.set(task.id, taskLosses)
      }
    }
  }

  return {
    records,
    tasks: PING_TASKS.filter(task => availableTasks.has(task.id)).map(task => ({
      id: task.id,
      key: task.key,
      name: pingTaskNames[task.key],
      interval: 60,
      loss: losses.has(task.id)
        ? losses.get(task.id)!.reduce((sum, value) => sum + value, 0) / losses.get(task.id)!.length
        : undefined,
    })),
  }
}

export async function fetchServer(uuid: string): Promise<CfServer> {
  const server = await request<CfServer>(`/api/server?id=${encodeURIComponent(uuid)}`)
  return { ...server, sysConfig: { ...cachedSysConfig, ...server.sysConfig } }
}

export function buildAdminUrl(): string {
  return `${window.location.origin}/admin#/admin`
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const config = cachedSiteConfig ?? await fetchSiteConfig()
  // 与 CFSM 历史接口一致：访客最多 24 小时，登录后最多 7 天。
  const historyHours = config.authorization ? 168 : 24
  return {
    ping_record_preserve_time: historyHours,
    record_preserve_time: historyHours,
    sitename: config.site_title || document.title || 'CF Server Monitor',
    themeSettings: adaptThemeOptions(config.theme_options),
  }
}

export async function getVersion(): Promise<VersionInfo> {
  const config = cachedSiteConfig ?? await fetchSiteConfig()
  return { version: config.version || '', hash: '' }
}

export { request as cfRequest, enabled as isEnabledValue }
