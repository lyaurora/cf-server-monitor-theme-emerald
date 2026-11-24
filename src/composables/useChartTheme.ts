import dayjs from 'dayjs'
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

const HTML_ESCAPE_REGEX = /[&<>"']/g
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(HTML_ESCAPE_REGEX, character => HTML_ENTITIES[character]!)
}

export function formatChartTooltipTime(time: string | number, hours: number): string {
  const date = dayjs(time)
  if (hours < 24)
    return date.format('HH:mm:ss')
  return date.format('MM/DD HH:mm')
}

export function renderTooltipRow(color: string, label: string, valueText: string, truncateLabel = false): string {
  const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:8px;flex-shrink:0"></span>`
  const labelStyle = truncateLabel ? ' style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"' : ''
  return `<div style="display:flex;align-items:center">${colorDot}<span${labelStyle}>${escapeHtml(label)}</span><span style="margin-left:auto;padding-left:16px;font-weight:600;font-variant-numeric:tabular-nums">${escapeHtml(valueText)}</span></div>`
}

export function useChartTheme(options: { alwaysBlurTooltip?: boolean, lightBorderColor?: string } = {}) {
  const appStore = useAppStore()
  const isDark = computed(() => appStore.isDark)

  const chartThemeColors = computed(() => ({
    text: isDark.value ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)',
    textSecondary: isDark.value ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.55)',
    textTertiary: isDark.value ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
    borderColor: isDark.value ? 'rgba(255, 255, 255, 0.1)' : (options.lightBorderColor ?? 'rgba(0, 0, 0, 0.1)'),
    splitLineColor: isDark.value ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)',
    tooltipBg: isDark.value ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.8)',
    tooltipShadow: isDark.value ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.06)',
    crosshairColor: isDark.value ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
  }))

  const baseTooltipConfig = computed(() => ({
    trigger: 'axis' as const,
    confine: false,
    backgroundColor: chartThemeColors.value.tooltipBg,
    borderColor: 'transparent',
    borderWidth: 0,
    borderRadius: 6,
    textStyle: {
      color: chartThemeColors.value.text,
      fontSize: 12,
      lineHeight: 20,
    },
    extraCssText: `${options.alwaysBlurTooltip || appStore.backgroundEnabled ? 'backdrop-filter: blur(5px);' : ''}z-index:9;box-shadow:0 0 0 1px ${chartThemeColors.value.tooltipShadow}, 0 0 16px ${chartThemeColors.value.tooltipShadow}`,
    axisPointer: {
      type: 'cross' as const,
      crossStyle: {
        color: chartThemeColors.value.textTertiary,
      },
      lineStyle: {
        color: chartThemeColors.value.crosshairColor,
        width: 1,
        type: 'dashed' as const,
      },
      shadowStyle: {
        color: chartThemeColors.value.crosshairColor,
      },
    },
  }))

  return {
    isDark,
    chartThemeColors,
    baseTooltipConfig,
  }
}
