export interface RegionInfo {
  en: string
  zh: string
  code: string
  aliases: string[]
}

const ISO_REGION_CODE_REGEX = /^[A-Z]{2}$/
const REGIONAL_INDICATOR_BASE = 0x1F1E6
const ASCII_A_CODE = 65

/** 支持的所有 ISO 两位国家/地区代码（用于按名称反查和搜索匹配） */
const ALL_REGION_CODES = [
  'AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ',
  'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ',
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ',
  'DE DG DJ DK DM DO DZ',
  'EC EE EG EH ER ES ET',
  'FI FJ FK FM FO FR',
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY',
  'HK HM HN HR HT HU',
  'ID IE IL IM IN IO IQ IR IS IT',
  'JE JM JO JP',
  'KE KG KH KI KM KN KP KR KW KY KZ',
  'LA LB LC LI LK LR LS LT LU LV LY',
  'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ',
  'NA NC NE NF NG NI NL NO NP NR NU NZ',
  'OM',
  'PA PE PF PG PH PK PL PM PN PR PS PT PW PY',
  'QA',
  'RE RO RS RU RW',
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ',
  'TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ',
  'UA UG UM UN US UY UZ',
  'VA VC VE VG VI VN VU',
  'WF WS',
  'XK',
  'YE YT',
  'ZA ZM ZW',
].join(' ').split(' ')

interface RegionOverride {
  en?: string
  zh?: string
  aliases?: string[]
}

/** 常用简称、繁体中文及地图常见名称补充，弥补 Intl.DisplayNames 的长名称或命名差异 */
const REGION_OVERRIDES: Record<string, RegionOverride> = {
  AE: { zh: '阿联酋' },
  AT: { aliases: ['奧地利'] },
  AU: { aliases: ['澳洲'] },
  BA: { zh: '波黑' },
  BE: { aliases: ['比利時'] },
  BF: { aliases: ['burkina', '布吉納法索'] },
  BG: { aliases: ['保加利亞'] },
  BN: { aliases: ['汶萊'] },
  BO: { aliases: ['玻利維亞'] },
  BS: { aliases: ['巴哈馬'] },
  BW: { aliases: ['波札那'] },
  CD: { en: 'Democratic Republic of Congo', zh: '刚果民主共和国', aliases: ['drc', 'congo', '刚果', '剛果'] },
  CF: { aliases: ['central african', '中非'] },
  CG: { en: 'Republic of Congo', zh: '刚果共和国', aliases: ['congo', '刚果', '剛果'] },
  CI: { en: 'Ivory Coast', zh: '科特迪瓦', aliases: ['象牙海岸'] },
  CM: { aliases: ['喀麥隆'] },
  CN: { zh: '中国', aliases: ['china', '中华人民共和国', 'prc'] },
  CO: { aliases: ['哥倫比亞'] },
  CR: { aliases: ['哥斯達黎加'] },
  CZ: { en: 'Czech Republic', zh: '捷克', aliases: ['czech', 'czechia'] },
  DE: { aliases: ['deutschland', '德國'] },
  DO: { zh: '多明尼加', aliases: ['dominican', '多米尼加'] },
  DZ: { aliases: ['阿爾及利亞'] },
  EC: { aliases: ['厄瓜多爾'] },
  EE: { aliases: ['愛沙尼亞'] },
  ET: { aliases: ['埃塞俄比亞'] },
  FI: { aliases: ['芬蘭'] },
  FK: { aliases: ['falkland', '福克兰', '福克蘭'] },
  FR: { aliases: ['法國'] },
  GB: { aliases: ['uk', 'britain', '英國'] },
  GF: { aliases: ['法屬圭亞那'] },
  GH: { aliases: ['迦納'] },
  GM: { aliases: ['甘比亞'] },
  GN: { aliases: ['幾內亞'] },
  GR: { aliases: ['希臘'] },
  GT: { aliases: ['危地馬拉'] },
  GW: { aliases: ['幾內亞比索'] },
  GY: { aliases: ['圭亞那'] },
  HK: { en: 'Hong Kong', zh: '香港', aliases: ['hongkong'] },
  HR: { aliases: ['克羅地亞'] },
  ID: { aliases: ['印尼'] },
  JM: { aliases: ['牙買加'] },
  KE: { aliases: ['肯亞'] },
  KR: { en: 'South Korea', zh: '韩国', aliases: ['korea', '南韩', '韓國'] },
  LA: { aliases: ['老撾'] },
  LR: { aliases: ['賴比瑞亞'] },
  LV: { aliases: ['拉脫維亞'] },
  LY: { aliases: ['利比亞'] },
  MK: { aliases: ['macedonia'] },
  ML: { aliases: ['馬利'] },
  MM: { en: 'Myanmar', zh: '缅甸', aliases: ['burma', '緬甸'] },
  MO: { en: 'Macao', zh: '澳门', aliases: ['macau', '澳門'] },
  MY: { aliases: ['馬來西亞'] },
  NA: { aliases: ['納米比亞'] },
  NE: { aliases: ['尼日爾'] },
  NG: { aliases: ['尼日利亞'] },
  NL: { aliases: ['holland', '荷蘭'] },
  PA: { aliases: ['巴拿馬'] },
  PE: { aliases: ['秘魯'] },
  PH: { aliases: ['菲律賓'] },
  PL: { aliases: ['波蘭'] },
  PS: { en: 'Palestine', zh: '巴勒斯坦' },
  RO: { aliases: ['羅馬尼亞'] },
  RU: { aliases: ['俄國', '俄国'] },
  RW: { aliases: ['盧旺達'] },
  SD: { aliases: ['蘇丹'] },
  SI: { aliases: ['斯洛文尼亞'] },
  SN: { aliases: ['塞內加爾'] },
  SR: { aliases: ['蘇里南'] },
  SS: { aliases: ['南蘇丹'] },
  SV: { aliases: ['薩爾瓦多'] },
  SZ: { aliases: ['swaziland'] },
  TH: { aliases: ['泰國'] },
  TT: { aliases: ['trinidad', '特立尼达', '特立尼達'] },
  TR: { en: 'Turkey', zh: '土耳其', aliases: ['türkiye', 'turkiye'] },
  TW: { en: 'Taiwan', zh: '台湾', aliases: ['台灣'] },
  TZ: { aliases: ['坦尚尼亞'] },
  UG: { aliases: ['烏干達'] },
  US: { en: 'United States', zh: '美国', aliases: ['usa', 'america', '美利坚', '美國'] },
  UY: { aliases: ['烏拉圭'] },
  VA: { en: 'Vatican City', zh: '梵蒂冈' },
  VE: { aliases: ['委內瑞拉'] },
  ZM: { aliases: ['尚比亞'] },
  ZW: { aliases: ['辛巴威'] },
}

const zhDisplayNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['zh-Hans'], { type: 'region' })
  : null
const enDisplayNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null

const regionInfoByCode = new Map<string, RegionInfo>()

function flagEmojiToCode(value: string): string | null {
  const chars = Array.from(value)
  if (chars.length !== 2)
    return null
  const first = chars[0]!.codePointAt(0)! - REGIONAL_INDICATOR_BASE
  const second = chars[1]!.codePointAt(0)! - REGIONAL_INDICATOR_BASE
  if (first < 0 || first > 25 || second < 0 || second > 25)
    return null
  return String.fromCharCode(ASCII_A_CODE + first, ASCII_A_CODE + second)
}

function resolveRegionInfo(code: string): RegionInfo | null {
  if (!ISO_REGION_CODE_REGEX.test(code))
    return null
  const cached = regionInfoByCode.get(code)
  if (cached)
    return cached

  const override = REGION_OVERRIDES[code]
  const intlZh = zhDisplayNames?.of(code)
  const intlEn = enDisplayNames?.of(code)
  const zh = override?.zh ?? intlZh ?? code
  const en = override?.en ?? intlEn ?? code
  const aliasSet = new Set<string>([code, en, zh])
  if (intlZh)
    aliasSet.add(intlZh)
  if (intlEn)
    aliasSet.add(intlEn)
  for (const alias of override?.aliases ?? [])
    aliasSet.add(alias)

  const info: RegionInfo = {
    code,
    en,
    zh,
    aliases: Array.from(aliasSet),
  }
  regionInfoByCode.set(code, info)
  return info
}

/**
 * 提取两位 ISO 地区代码，兼容国旗 Emoji 和 ISO 代码字符串。
 */
export function parseRegionCode(region: string | null | undefined): string | null {
  if (!region)
    return null
  const trimmed = region.trim()
  if (!trimmed)
    return null

  const fromEmoji = flagEmojiToCode(trimmed)
  if (fromEmoji)
    return fromEmoji

  const upper = trimmed.toUpperCase()
  if (ISO_REGION_CODE_REGEX.test(upper))
    return upper

  return null
}

let aliasToCodeMapCache: Map<string, string> | null = null

/** 供世界地图等按国家/地区名称反查 ISO 代码使用（惰性初始化） */
export function getRegionAliasToCodeMap(): Map<string, string> {
  if (aliasToCodeMapCache)
    return aliasToCodeMapCache

  const map = new Map<string, string>()
  for (const code of ALL_REGION_CODES) {
    const info = resolveRegionInfo(code)
    if (!info)
      continue
    for (const alias of info.aliases) {
      const key = alias.trim().toLowerCase()
      if (!key || map.has(key))
        continue
      map.set(key, info.code)
    }
  }
  aliasToCodeMapCache = map
  return map
}

/**
 * 检查地区（国旗 Emoji 或 ISO 国家码）是否匹配搜索词
 */
export function isRegionMatch(region: string, searchTerm: string): boolean {
  const trimmedSearch = searchTerm.trim()
  if (!trimmedSearch)
    return true
  const lowerSearchTerm = trimmedSearch.toLowerCase()

  if (region === trimmedSearch || region.toLowerCase().includes(lowerSearchTerm)) {
    return true
  }

  const code = parseRegionCode(region)
  const regionInfo = code ? resolveRegionInfo(code) : null
  if (!regionInfo)
    return false

  if (regionInfo.en.toLowerCase().includes(lowerSearchTerm))
    return true

  if (regionInfo.zh.toLowerCase().includes(lowerSearchTerm))
    return true

  return regionInfo.aliases.some(alias => alias.toLowerCase().includes(lowerSearchTerm))
}

/**
 * 获取地区的显示名称，兼容国旗 Emoji 和 ISO 国家码
 */
export function getRegionDisplayName(region: string, language: 'en' | 'zh' = 'zh'): string {
  const code = parseRegionCode(region)
  const regionInfo = code ? resolveRegionInfo(code) : null
  if (!regionInfo)
    return region

  return language === 'zh' ? regionInfo.zh : regionInfo.en
}

/**
 * 获取地区代码（如：HK, CN, US），兼容国旗 Emoji 和 ISO 国家码
 */
export function getRegionCode(region: string): string {
  return parseRegionCode(region) ?? region
}
