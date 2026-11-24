import { registerMap } from 'echarts/core'
import { getRegionAliasToCodeMap } from '@/utils/regionHelper'

type WorldGeoJson = Exclude<
  Parameters<typeof registerMap>[1],
  string | { geoJSON: unknown } | { svg: unknown }
>

const WORLD_MAP_NAME = 'cf-server-monitor-world'
// 世界地图数据源：多 CDN 阶梯竞速回退，避免单一 CDN 故障或阻塞拖慢地图展示
const WORLD_GEO_JSON_URLS = [
  'https://cdn.jsdelivr.net/gh/apache/echarts-www@master/asset/map/json/world.json',
  'https://fastly.jsdelivr.net/gh/apache/echarts-www@master/asset/map/json/world.json',
  'https://gcore.jsdelivr.net/gh/apache/echarts-www@master/asset/map/json/world.json',
  'https://raw.githubusercontent.com/apache/echarts-www/master/asset/map/json/world.json',
]
const WORLD_MAP_CACHE_KEY = 'cf-server-monitor-theme-emerald:world-map'

const ECHARTS_WORLD_NAME_TO_CODE: Record<string, string> = {
  'aland': 'AX',
  'andorra': 'AD',
  'antigua and barb.': 'AG',
  'bosnia and herz.': 'BA',
  'br. indian ocean ter.': 'IO',
  'cayman is.': 'KY',
  'central african rep.': 'CF',
  'congo': 'CG',
  'czech rep.': 'CZ',
  'côte d\'ivoire': 'CI',
  'dem. rep. congo': 'CD',
  'dem. rep. korea': 'KP',
  'dominican rep.': 'DO',
  'eq. guinea': 'GQ',
  'faeroe is.': 'FO',
  'falkland is.': 'FK',
  'fr. polynesia': 'PF',
  'fr. s. antarctic lands': 'TF',
  'heard i. and mcdonald is.': 'HM',
  'lao pdr': 'LA',
  'macedonia': 'MK',
  'n. cyprus': 'CY',
  'n. mariana is.': 'MP',
  's. geo. and s. sandw. is.': 'GS',
  's. sudan': 'SS',
  'saint helena': 'SH',
  'saint lucia': 'LC',
  'solomon is.': 'SB',
  'st. pierre and miquelon': 'PM',
  'st. vin. and gren.': 'VC',
  'swaziland': 'SZ',
  'são tomé and principe': 'ST',
  'turks and caicos is.': 'TC',
  'u.s. virgin is.': 'VI',
  'w. sahara': 'EH',
}

let worldMapPromise: Promise<string> | null = null
let worldMapRegistered = false

function isValidWorldGeoJson(value: unknown): value is WorldGeoJson {
  return Boolean(
    value
    && typeof value === 'object'
    && 'type' in value
    && 'features' in value
    && (value as { type?: unknown }).type === 'FeatureCollection'
    && Array.isArray((value as { features?: unknown }).features),
  )
}

function pruneStaleWorldMapCache(): void {
  if (typeof window === 'undefined')
    return

  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(WORLD_MAP_CACHE_KEY) || key === WORLD_MAP_CACHE_KEY)
        continue
      window.localStorage.removeItem(key)
    }
  }
  catch {
  }
}

function readCachedWorldGeoJson(): WorldGeoJson | null {
  if (typeof window === 'undefined')
    return null

  try {
    const raw = window.localStorage.getItem(WORLD_MAP_CACHE_KEY)
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as { data?: unknown }
    if (!isValidWorldGeoJson(parsed.data)) {
      window.localStorage.removeItem(WORLD_MAP_CACHE_KEY)
      return null
    }

    return parsed.data
  }
  catch {
    return null
  }
}

function writeCachedWorldGeoJson(worldGeoJson: WorldGeoJson): void {
  if (typeof window === 'undefined')
    return

  try {
    window.localStorage.setItem(
      WORLD_MAP_CACHE_KEY,
      JSON.stringify({
        data: worldGeoJson,
      }),
    )
    pruneStaleWorldMapCache()
  }
  catch {
  }
}

function normalizeCountryName(name: string): string {
  return name.trim().toLowerCase()
}

function resolveCountryCode(name: string, aliasToCodeMap: Map<string, string>): string | null {
  const key = normalizeCountryName(name)
  if (!key)
    return null
  return ECHARTS_WORLD_NAME_TO_CODE[key] ?? aliasToCodeMap.get(key) ?? null
}

function normalizeWorldGeoJson(worldGeoJson: WorldGeoJson): WorldGeoJson {
  const aliasToCodeMap = getRegionAliasToCodeMap()
  for (const feature of worldGeoJson.features) {
    const name = typeof feature.properties?.name === 'string' ? feature.properties.name : ''
    const code = resolveCountryCode(name, aliasToCodeMap)
    if (!code)
      continue

    feature.properties.name = code
  }

  return worldGeoJson
}

async function fetchWorldGeoJsonFromUrl(url: string, timeoutMs: number, parentSignal: AbortSignal): Promise<WorldGeoJson> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (parentSignal.aborted)
    controller.abort()
  else
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)

    const data = await response.json() as unknown
    if (!isValidWorldGeoJson(data))
      throw new Error('Invalid world GeoJSON')

    return normalizeWorldGeoJson(data)
  }
  catch (error) {
    if (!parentSignal.aborted)
      console.warn(`加载世界地图失败: ${url}`, error)
    throw error
  }
  finally {
    window.clearTimeout(timeoutId)
    parentSignal.removeEventListener('abort', onParentAbort)
  }
}

async function loadWorldGeoJson(): Promise<WorldGeoJson> {
  const cachedWorldGeoJson = readCachedWorldGeoJson()
  if (cachedWorldGeoJson)
    return cachedWorldGeoJson

  const raceController = new AbortController()
  try {
    const primary = fetchWorldGeoJsonFromUrl(WORLD_GEO_JSON_URLS[0]!, 8000, raceController.signal)
    const fallbackPromise = new Promise<WorldGeoJson>((resolve, reject) => {
      let started = false
      let timer: number | undefined
      const startFallbacks = () => {
        if (started)
          return
        started = true
        if (raceController.signal.aborted) {
          reject(new Error('Aborted'))
          return
        }
        void Promise.any(WORLD_GEO_JSON_URLS.slice(1).map(url => fetchWorldGeoJsonFromUrl(url, 8000, raceController.signal)))
          .then(resolve, reject)
      }
      const onRaceAbort = () => {
        window.clearTimeout(timer)
        if (!started) {
          started = true
          reject(new Error('Aborted'))
        }
      }
      raceController.signal.addEventListener('abort', onRaceAbort, { once: true })
      timer = window.setTimeout(startFallbacks, 2500)
      primary.then(
        () => window.clearTimeout(timer),
        () => {
          window.clearTimeout(timer)
          startFallbacks()
        },
      )
    })

    const worldGeoJson = await Promise.any([primary, fallbackPromise])
    raceController.abort()
    writeCachedWorldGeoJson(worldGeoJson)
    return worldGeoJson
  }
  catch {
    throw new Error('Failed to load world map from all CDNs')
  }
  finally {
    raceController.abort()
  }
}

export async function ensureWorldMapRegistered(): Promise<string> {
  if (worldMapRegistered)
    return WORLD_MAP_NAME

  if (!worldMapPromise) {
    worldMapPromise = loadWorldGeoJson()
      .then((worldGeoJson) => {
        registerMap(WORLD_MAP_NAME, worldGeoJson)
        worldMapRegistered = true
        return WORLD_MAP_NAME
      })
      .catch((error) => {
        worldMapPromise = null
        throw error
      })
  }

  return worldMapPromise
}
