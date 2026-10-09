<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { useDebounceFn } from '@vueuse/core'
import { computed, defineAsyncComponent, nextTick, onActivated, onDeactivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import NodeCard from '@/components/NodeCard.vue'
import NodeGeneralCards from '@/components/NodeGeneralCards.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { useNodeListTransition } from '@/composables/useNodeListTransition'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { isNodeInGroup, parseNodeGroups } from '@/utils/groupHelper'
import { isRegionMatch } from '@/utils/regionHelper'

defineOptions({ name: 'HomeView' })

const NodeList = defineAsyncComponent(() => import('@/components/NodeList.vue'))
const PingChart = defineAsyncComponent(() => import('@/components/PingChart.vue'))

const nodeItemStaggerMs = 35
const nodeItemStaggerLimit = 12

const appStore = useAppStore()
const { pickSurfaceClass } = useBackgroundSurface()
const { beforeUpdate, beforeLeave, afterLeave } = useNodeListTransition()
const nodesStore = useNodesStore()
const router = useRouter()

onActivated(() => {
  if (appStore.homeScrollPosition > 0) {
    nextTick(() => {
      window.scrollTo({ top: appStore.homeScrollPosition, behavior: 'instant' })
    })
  }
})

onDeactivated(() => {
  appStore.homeScrollPosition = window.scrollY
})

const searchText = ref('')
const debouncedSearchText = ref('')
const showOfflineOnly = ref(false)
const selectedPingNodeUuid = ref<string | null>(null)

const updateDebouncedSearch = useDebounceFn((value: string) => {
  debouncedSearchText.value = value
}, 300)

watch(searchText, (value) => {
  updateDebouncedSearch(value)
  if (!value.trim())
    debouncedSearchText.value = ''
})

const groups = computed(() => [
  { tab: '全部节点', name: 'all' },
  ...nodesStore.groups.map(g => ({ tab: g, name: g })),
])

watch(
  () => nodesStore.groups,
  (gs) => {
    const cur = appStore.nodeSelectedGroup
    if (cur !== 'all' && !gs.includes(cur)) {
      appStore.nodeSelectedGroup = 'all'
    }
  },
  { immediate: true },
)

function isNodeMatchSearch(node: typeof nodesStore.nodes[number], search: string): boolean {
  if (!search.trim())
    return true
  const lowerSearch = search.toLowerCase().trim()
  if (node.name.toLowerCase().includes(lowerSearch))
    return true
  if (node.region && isRegionMatch(node.region, search))
    return true
  if (node.os && node.os.toLowerCase().includes(lowerSearch))
    return true
  if (parseNodeGroups(node.group).some(group => group.toLowerCase().includes(lowerSearch)))
    return true
  if (node.tags && node.tags.toLowerCase().includes(lowerSearch))
    return true
  return false
}

const groupNodeList = computed(() => {
  return nodesStore.nodes.filter(node => isNodeInGroup(node.group, appStore.nodeSelectedGroup))
})

const sampledGroupNodeList = computed(() => {
  return nodesStore.earthNodes.filter(node => isNodeInGroup(node.group, appStore.nodeSelectedGroup))
})

const searchedNodeList = computed(() => {
  return groupNodeList.value.filter(n => isNodeMatchSearch(n, debouncedSearchText.value))
})

const offlineNodes = computed(() => searchedNodeList.value.filter(n => !n.online))

const nodeList = computed(() => {
  const filtered = showOfflineOnly.value ? offlineNodes.value : searchedNodeList.value
  if (!appStore.offlineNodesLast)
    return filtered
  // 稳定排序：在线节点在前、离线节点在后，组内保持原有顺序
  return [...filtered].sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1))
})

const selectedPingNode = computed(() => {
  if (!selectedPingNodeUuid.value)
    return null
  return nodesStore.nodes.find(node => node.uuid === selectedPingNodeUuid.value) ?? null
})

const pingDialogOpen = computed({
  get: () => selectedPingNode.value !== null,
  set: (open: boolean) => {
    if (!open)
      selectedPingNodeUuid.value = null
  },
})

function handleNodeClick(node: typeof nodesStore.nodes[number]) {
  router.push({
    name: 'instance-detail',
    params: { id: node.uuid },
  })
}

function handlePingClick(node: NodeData) {
  selectedPingNodeUuid.value = node.uuid
}

function getNodeItemTransitionKey(node: typeof nodesStore.nodes[number]): string {
  return `${appStore.nodeSelectedGroup}-${node.uuid}`
}

function getNodeItemTransitionStyle(index: number): Record<string, string> {
  return {
    '--node-item-delay': `${Math.min(index, nodeItemStaggerLimit) * nodeItemStaggerMs}ms`,
  }
}
</script>

<template>
  <div class="home-view">
    <div v-if="appStore.alertEnabled && appStore.alertContent" class="alert px-4">
      <Alert :class="pickSurfaceClass('border-none bg-background rounded-md', 'border-none bg-background/60 backdrop-blur-xs rounded-md')">
        <AlertTitle v-if="appStore.alertTitle">
          {{ appStore.alertTitle }}
        </AlertTitle>
        <AlertDescription>
          <MarkdownRenderer :content="appStore.alertContent" />
        </AlertDescription>
      </Alert>
    </div>

    <NodeGeneralCards
      v-if="appStore.earthViewMode !== 'hide'"
      :nodes="groupNodeList"
      :globe-nodes="sampledGroupNodeList"
      :transition-key="appStore.nodeSelectedGroup"
    />

    <div class="node-info p-4 pt-0 flex flex-col gap-4 relative z-1 md:pointer-events-none" :class="appStore.earthViewMode === 'hide' && 'pt-4'">
      <div class="nodes">
        <Tabs v-model="appStore.nodeSelectedGroup" class="w-full flex-col gap-4">
          <div class="flex gap-2 items-start flex-wrap">
            <div class="min-w-28 flex-1 overflow-x-auto rounded-sm md:pointer-events-auto">
              <TabsList :class="pickSurfaceClass('w-max h-8 bg-background/60 rounded-md', 'w-max h-8 bg-background/50 backdrop-blur-xl rounded-md')">
                <TabsTrigger
                  v-for="g in groups" :key="g.name" :value="g.name"
                  class="h-6.5 flex-none shrink-0 text-xs border-none data-[state=active]:text-emerald-600 shadow-none rounded-sm"
                >
                  {{ g.tab }}
                </TabsTrigger>
              </TabsList>
            </div>
            <div class="ml-auto search flex max-w-full gap-2 items-center pointer-events-auto">
              <DataTooltip :content="String(offlineNodes.length)" class="h-8 shrink-0">
                <Button
                  variant="outline" size="icon" :aria-label="`仅看离线节点，${offlineNodes.length} 台离线`"
                  :aria-pressed="showOfflineOnly"
                  class="h-8 w-8 border-none shadow-none rounded-md"
                  :class="[
                    pickSurfaceClass('bg-background hover:bg-background/95', 'bg-background/50 hover:bg-background/60 backdrop-blur-xs'),
                    offlineNodes.length > 0 && '!text-red-500',
                    showOfflineOnly && '!bg-emerald-500/15',
                  ]"
                  @click="showOfflineOnly = !showOfflineOnly"
                >
                  <Icon icon="tabler:server-off" :width="14" :height="14" />
                </Button>
              </DataTooltip>
              <Button
                variant="outline" size="icon" aria-label="卡片视图"
                :aria-pressed="appStore.nodeViewMode === 'card'"
                class="h-8 w-8 border-none shadow-none rounded-md"
                :class="[pickSurfaceClass('bg-background hover:bg-background/95', 'bg-background/50 hover:bg-background/60 backdrop-blur-xs'), appStore.nodeViewMode === 'card' ? '!text-emerald-600 !bg-background' : '']"
                @click="appStore.nodeViewMode = 'card'"
              >
                <Icon icon="tabler:layout-grid" :width="14" :height="14" />
              </Button>
              <Button
                variant="outline" size="icon" aria-label="列表视图"
                :aria-pressed="appStore.nodeViewMode === 'list'"
                class="h-8 w-8 border-none shadow-none rounded-md"
                :class="[pickSurfaceClass('bg-background hover:bg-background/95', 'bg-background/50 hover:bg-background/60 backdrop-blur-xs'), appStore.nodeViewMode === 'list' ? '!text-emerald-600 !bg-background' : '']"
                @click="appStore.nodeViewMode = 'list'"
              >
                <Icon icon="tabler:table" :width="14" :height="14" />
              </Button>
              <div
                class="group/search relative z-1 h-8 w-8 transition-all focus-within:w-48 sm:focus-within:w-60"
                :class="searchText && 'w-48 sm:w-60'"
              >
                <Input
                  v-model="searchText" placeholder="搜索节点名称、地区、系统" aria-label="搜索节点"
                  class="h-8 w-full rounded-md border-none shadow-none pl-2.5 pr-0 placeholder:text-transparent group-focus-within/search:pl-7.5 group-focus-within/search:pr-8 group-focus-within/search:placeholder:text-muted-foreground focus:!ring-emerald-500/10"
                  :class="[pickSurfaceClass('bg-background hover:!bg-background/95 focus:!bg-background', 'bg-background/50 hover:!bg-background/60 focus:!bg-background/80 backdrop-blur-xs'), searchText && '!pl-7.5 !pr-8 placeholder:!text-muted-foreground']"
                />
                <Button
                  v-if="searchText" variant="ghost" size="icon-sm" aria-label="清除搜索"
                  class="absolute right-0 top-0 h-8 w-8" @click="searchText = ''"
                >
                  <Icon icon="tabler:x" :width="14" :height="14" />
                </Button>
                <Icon
                  icon="tabler:search" :width="14" :height="14"
                  class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                />
              </div>
            </div>
          </div>
          <TabsContent :key="appStore.nodeSelectedGroup" :value="appStore.nodeSelectedGroup" class="pointer-events-auto">
            <TransitionGroup
              v-if="nodeList.length !== 0 && appStore.nodeViewMode === 'card'"
              :appear="!appStore.disablePageAnimation"
              :css="!appStore.disablePageAnimation"
              :move-class="appStore.disablePageAnimation ? 'transition-none' : undefined"
              name="node-card-switch"
              tag="div"
              class="relative content-start gap-3 grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]"
              @vue:before-update="beforeUpdate"
              @before-leave="beforeLeave"
              @after-leave="afterLeave"
              @leave-cancelled="afterLeave"
            >
              <div
                v-for="(node, index) in nodeList"
                :key="getNodeItemTransitionKey(node)"
                class="min-w-0"
                :style="getNodeItemTransitionStyle(index)"
              >
                <NodeCard :node="node" @click="handleNodeClick(node)" @ping-click="handlePingClick" />
              </div>
            </TransitionGroup>
            <NodeList
              v-else-if="nodeList.length !== 0 && appStore.nodeViewMode === 'list'"
              :nodes="nodeList"
              :transition-key="appStore.nodeSelectedGroup"
              @click="handleNodeClick"
              @ping-click="handlePingClick"
            />
            <div v-else class="text-muted-foreground text-center py-8">
              <Empty :description="showOfflineOnly ? '当前范围内没有离线节点' : debouncedSearchText.trim() ? '没有匹配的节点' : '暂无节点'">
                <template v-if="showOfflineOnly || debouncedSearchText.trim()" #extra>
                  <Button v-if="showOfflineOnly" variant="outline" size="sm" @click="showOfflineOnly = false">
                    显示全部状态
                  </Button>
                  <Button v-else variant="outline" size="sm" @click="searchText = ''">
                    清除搜索
                  </Button>
                </template>
              </Empty>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>

    <Dialog v-model:open="pingDialogOpen">
      <DialogContent
        v-if="selectedPingNode"
        class="max-w-6xl gap-0 overflow-hidden border-emerald-600/10 p-0 shadow-[0_0_2rem] shadow-emerald-800/10 transition-all"
        :class="pickSurfaceClass('bg-background', 'bg-background/60')"
      >
        <DialogHeader class="flex h-13 flex-row items-center px-4">
          <DialogTitle class="truncate">
            {{ selectedPingNode.name }} 延迟 / 丢包
          </DialogTitle>
          <DialogDescription class="sr-only">
            查看所选时间范围内各线路的延迟和丢包情况，可切换时间范围与线路。
          </DialogDescription>
          <div class="absolute inset-0 mx-0 max-w-none overflow-hidden bg-slate-50 dark:bg-slate-900/50 -z-9 zoom-90">
            <div class="absolute top-0 left-1/2 -ml-152 h-100 w-325 dark:mask-[linear-gradient(white,transparent)]">
              <div
                class="absolute inset-0 bg-linear-to-r from-emerald-500 to-lime-300 mask-[radial-gradient(farthest-side_at_top,white,transparent)] opacity-40 dark:from-emerald-500/30 dark:to-lime-300/30 dark:opacity-100"
              >
                <svg
                  aria-hidden="true"
                  class="absolute inset-x-0 inset-y-[-50%] h-[200%] w-full skew-y-[-18deg] fill-black/40 stroke-black/50 mix-blend-overlay dark:fill-white/2.5 dark:stroke-white/5"
                >
                  <defs>
                    <pattern id="_S_1_" width="72" height="56" patternUnits="userSpaceOnUse" x="-12" y="4">
                      <path d="M.5 56V.5H72" fill="none" />
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" stroke-width="0" fill="url(#_S_1_)" /><svg
                    x="-12" y="4"
                    class="overflow-visible"
                  >
                    <rect stroke-width="0" width="73" height="57" x="288" y="168" />
                    <rect stroke-width="0" width="73" height="57" x="144" y="56" />
                    <rect stroke-width="0" width="73" height="57" x="504" y="168" />
                    <rect stroke-width="0" width="73" height="57" x="720" y="336" />
                  </svg>
                </svg>
              </div>
            </div>
          </div>
        </DialogHeader>
        <div class="max-h-[calc(90vh-4rem)] overflow-y-auto p-4 pt-0">
          <PingChart :uuid="selectedPingNode.uuid" />
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.node-card-switch-enter-active,
.node-card-switch-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 180ms ease;
}

.node-card-switch-enter-active {
  transition-delay: var(--node-item-delay, 0ms);
}

.node-card-switch-move {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.node-card-switch-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
  filter: blur(3px);
}

.node-card-switch-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.99);
  filter: blur(2px);
}

@media (prefers-reduced-motion: reduce) {
  .node-card-switch-enter-active,
  .node-card-switch-leave-active,
  .node-card-switch-move {
    transition: none;
    transition-delay: 0ms;
  }

  .node-card-switch-enter-from,
  .node-card-switch-leave-to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
</style>
