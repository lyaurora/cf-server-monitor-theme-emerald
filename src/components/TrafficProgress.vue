<script setup lang="ts">
import { computed } from 'vue'
import { getTrafficLevel } from '@/utils/nodeHelper'

const props = defineProps<{
  percentage: number
  height?: number | string
}>()

const progressHeight = computed(() => {
  if (props.height === undefined)
    return undefined
  return typeof props.height === 'number' ? `${props.height}px` : props.height
})

/** 达到流量警戒阈值时整条进度条切换颜色（<80 保持原色，>=80 黄，>=95 红） */
const trafficToneClass = computed(() => {
  const level = getTrafficLevel(props.percentage)
  if (level === 'error')
    return 'bg-red-600'
  if (level === 'warning')
    return 'bg-yellow-500'
  return ''
})
</script>

<template>
  <div class="traffic-progress">
    <div class="traffic-progress__rail bg-muted" :style="{ height: progressHeight }">
      <div
        class="traffic-progress__fill traffic-progress__fill--last"
        :class="trafficToneClass || 'bg-green-600'"
        :style="{ width: `${percentage}%` }"
      />
    </div>
  </div>
</template>

<style scoped>
.traffic-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.traffic-progress__rail {
  position: relative;
  display: flex;
  overflow: hidden;
  height: 8px;
  border-radius: 5px;
  transition: background-color 0.3s;
}

.traffic-progress__fill {
  position: relative;
  height: 100%;
  transition:
    max-width 0.2s,
    width 0.2s,
    background-color 0.3s;
}

.traffic-progress__fill--last {
  border-top-right-radius: 5px;
  border-bottom-right-radius: 5px;
}
</style>
