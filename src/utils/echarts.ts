/**
 * ECharts 共享配置（折线图核心）
 *
 * 地图组件在 NodeEarthMaps 中按需注册，避免首页/详情折线图拉入 Geo/Map 代码。
 */
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'

use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
])

export default VChart
