<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed, ref } from 'vue'
import NodeListRow from '@/components/NodeListRow.vue'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { useNodeListTransition } from '@/composables/useNodeListTransition'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getTrafficUsedPercentage } from '@/utils/nodeHelper'
import { getOSName } from '@/utils/osImageHelper'

interface ColumnConfig {
  key: string
  label: string
  width: string | number
  sortable: boolean
}

const props = defineProps<{
  nodes: NodeData[]
  transitionKey?: string
}>()

const emit = defineEmits<{
  click: [node: NodeData]
  pingClick: [node: NodeData]
}>()

const rowStaggerMs = 35
const rowStaggerLimit = 12

const appStore = useAppStore()
const nodesStore = useNodesStore()
const { pickSurfaceClass } = useBackgroundSurface()
const { beforeUpdate, beforeLeave, afterLeave } = useNodeListTransition()

const columns: ColumnConfig[] = [
  { key: 'status', label: '状态', width: '40px', sortable: true },
  { key: 'os', label: '系统', width: '40px', sortable: true },
  { key: 'name', label: '节点', width: 'minmax(150px, 0.8fr)', sortable: true },
  { key: 'tags', label: '标签', width: 'minmax(180px, 1fr)', sortable: false },
  { key: 'cpu', label: 'CPU', width: '100px', sortable: true },
  { key: 'mem', label: '内存', width: '100px', sortable: true },
  { key: 'disk', label: '硬盘', width: '100px', sortable: true },
  { key: 'traffic', label: '流量', width: '100px', sortable: true },
  { key: 'rate', label: '速率', width: '80px', sortable: true },
  { key: 'latency', label: '延迟', width: '136px', sortable: false },
]

const sortKey = ref<string>('')
const sortDir = ref<1 | -1>(1)
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const visibleColumns = computed(() => columns.filter((col) => {
  if (col.key === 'traffic')
    return props.nodes.some(node => node.showTraffic !== false)
  if (col.key === 'latency')
    return nodesStore.showThreeNetDetails
  return true
}))
const offlineOverlayColumnStart = computed(() => visibleColumns.value.findIndex(col => col.key === 'name') + 1)

function getInitialSortDir(col: ColumnConfig): 1 | -1 {
  return ['status', 'os', 'name'].includes(col.key) ? 1 : -1
}

function handleSort(col: ColumnConfig) {
  if (!col.sortable)
    return
  if (sortKey.value === col.key) {
    if (sortDir.value === getInitialSortDir(col))
      sortDir.value = sortDir.value === 1 ? -1 : 1
    else
      sortKey.value = ''
  }
  else {
    sortKey.value = col.key
    sortDir.value = getInitialSortDir(col)
  }
}

function getSortLabel(col: ColumnConfig): string {
  if (sortKey.value !== col.key)
    return `${col.label}，未按此列排序，点击${getInitialSortDir(col) === 1 ? '升序' : '降序'}排列`
  const current = sortDir.value === 1 ? '升序' : '降序'
  const next = sortDir.value === getInitialSortDir(col)
    ? `点击切换为${sortDir.value === 1 ? '降序' : '升序'}`
    : '点击恢复默认顺序'
  return `${col.label}，当前${current}，${next}`
}

const sortedNodes = computed(() => {
  const nodes = [...props.nodes]
  const key = sortKey.value
  const dir = sortDir.value
  if (!key)
    return nodes
  return nodes.sort((a, b) => {
    switch (key) {
      case 'status': return dir * ((a.online ? 1 : 0) - (b.online ? 1 : 0))
      case 'name': return dir * nameCollator.compare(a.name || '', b.name || '')
      case 'os': {
        return dir * getOSName(a.os).localeCompare(getOSName(b.os), 'zh-CN')
      }
      case 'cpu': return dir * ((a.cpu ?? 0) - (b.cpu ?? 0))
      case 'mem': return dir * ((a.ram ?? 0) / (a.mem_total || 1) - (b.ram ?? 0) / (b.mem_total || 1))
      case 'disk': return dir * ((a.disk ?? 0) / (a.disk_total || 1) - (b.disk ?? 0) / (b.disk_total || 1))
      case 'traffic': return dir * (getTrafficUsedPercentage(a) - getTrafficUsedPercentage(b))
      case 'rate':
        return dir * (((a.net_out ?? 0) + (a.net_in ?? 0)) - ((b.net_out ?? 0) + (b.net_in ?? 0)))
      default: return 0
    }
  })
})

const gridStyle = computed(() => ({
  gridTemplateColumns: visibleColumns.value.map(c => c.width).join(' '),
}))

function handleClick(node: NodeData) {
  emit('click', node)
}

function openPingDialog(node: NodeData) {
  emit('pingClick', node)
}

function getRowTransitionKey(node: NodeData): string {
  return props.transitionKey ? `${props.transitionKey}-${node.uuid}` : node.uuid
}

function getRowTransitionStyle(index: number): Record<string, string> {
  return {
    '--node-row-delay': `${Math.min(index, rowStaggerLimit) * rowStaggerMs}ms`,
  }
}
</script>

<template>
  <div class="overflow-x-auto overflow-y-hidden min-w-0 p-1 -m-1">
    <div class="min-w-fit w-full flex flex-col gap-1">
      <!-- 表头 -->
      <div
        class="grid gap-2 rounded-lg p-2"
        :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/60 backdrop-blur-sm')"
        :style="gridStyle"
      >
        <div
          v-for="col in visibleColumns" :key="col.key"
          :class="['status', 'os'].includes(col.key) ? 'text-center' : 'text-left'"
        >
          <button
            v-if="col.sortable" type="button" class="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="getSortLabel(col)"
            @click="handleSort(col)"
          >
            {{ col.label }}
            <span aria-hidden="true" :class="sortKey === col.key ? 'text-foreground' : 'opacity-50'">
              {{ sortKey === col.key ? (sortDir === 1 ? '↑' : '↓') : '↕' }}
            </span>
          </button>
          <span v-else class="text-xs text-muted-foreground">{{ col.label }}</span>
        </div>
      </div>

      <TransitionGroup
        :appear="!appStore.disablePageAnimation"
        :css="!appStore.disablePageAnimation"
        :move-class="appStore.disablePageAnimation ? 'transition-none' : undefined"
        name="node-row-switch"
        tag="div"
        class="relative flex flex-col gap-1"
        @vue:before-update="beforeUpdate"
        @before-leave="beforeLeave"
        @after-leave="afterLeave"
        @leave-cancelled="afterLeave"
      >
        <NodeListRow
          v-for="(node, index) in sortedNodes"
          :key="getRowTransitionKey(node)"
          :node="node"
          :visible-columns="visibleColumns"
          :grid-style="gridStyle"
          :offline-overlay-column-start="offlineOverlayColumnStart"
          :style="getRowTransitionStyle(index)"
          @click="handleClick"
          @ping-click="openPingDialog"
        />
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.node-row-switch-enter-active,
.node-row-switch-leave-active {
  transition:
    opacity 170ms ease,
    transform 210ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 170ms ease;
}

.node-row-switch-enter-active {
  transition-delay: var(--node-row-delay, 0ms);
}

.node-row-switch-move {
  transition: transform 210ms cubic-bezier(0.22, 1, 0.36, 1);
}

.node-row-switch-enter-from {
  opacity: 0;
  transform: translateY(8px);
  filter: blur(3px);
}

.node-row-switch-leave-to {
  opacity: 0;
  transform: translateY(-5px);
  filter: blur(2px);
}

@media (prefers-reduced-motion: reduce) {
  .node-row-switch-enter-active,
  .node-row-switch-leave-active,
  .node-row-switch-move {
    transition: none;
    transition-delay: 0ms;
  }

  .node-row-switch-enter-from,
  .node-row-switch-leave-to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
</style>
