<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/sonner'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { CorsError } from '@/utils/api'
import { destroyInitManager, initApp, resumeLiveUpdates } from '@/utils/init'
import Background from './components/Background.vue'
import Footer from './components/Footer.vue'
import Header from './components/Header.vue'
import LoadingCover from './components/LoadingCover.vue'
import Provider from './components/Provider.vue'

const appStore = useAppStore()
const nodesStore = useNodesStore()

const corsDialogOpen = ref(false)
const corsAllowedOrigin = ref('')

onMounted(async () => {
  try {
    await initApp()
  }
  catch (error) {
    console.error('[App] Initialization failed:', error)
    if (error instanceof CorsError) {
      corsAllowedOrigin.value = error.origin
      corsDialogOpen.value = true
    }
  }
})

async function resumeConnection(): Promise<void> {
  if (!appStore.publicSettings) {
    window.location.reload()
    return
  }
  try {
    await resumeLiveUpdates()
  }
  catch (error) {
    console.error('[App] Reconnect failed:', error)
  }
}

onUnmounted(() => {
  destroyInitManager()
})
</script>

<template>
  <Provider>
    <Background />
    <LoadingCover v-if="appStore.loading" />
    <Header />
    <main v-if="!appStore.loading" class="flex-1">
      <div class="max-w-[1280px] mx-auto">
        <div
          v-if="nodesStore.livePaused || appStore.connectionError || nodesStore.wsConnectionState === 'reconnecting'"
          role="status" class="mx-4 mb-4 flex flex-wrap items-center gap-3 rounded-md bg-background/80 p-3 text-sm"
        >
          <span v-if="nodesStore.livePaused" class="flex-1">已达到设定的连接时长，实时更新已暂停。当前显示保留的数据。</span>
          <span v-else class="flex-1">页面与监控服务的连接中断，数据可能已过期。此提示不代表机器离线。</span>
          <Button size="sm" :disabled="nodesStore.pageLoading" @click="resumeConnection">
            {{ nodesStore.livePaused ? '继续实时更新' : '重新连接' }}
          </Button>
        </div>
        <RouterView v-slot="{ Component }">
          <KeepAlive :include="['HomeView']">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </div>
    </main>
    <Footer v-if="!appStore.loading" />
    <Toaster rich-colors close-button position="top-center" />
    <Dialog v-model:open="corsDialogOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>最后一步</DialogTitle>
          <DialogDescription class="leading-6">
            <p>当前页面无法访问 CF Server Monitor 后端。</p>
            <p>纯静态部署时需要前往后端的环境变量配置 <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">CORS_ALLOWED_ORIGINS</code></p>
          </DialogDescription>
        </DialogHeader>
        <div class="rounded-md border bg-muted/50 p-3 font-mono text-sm break-all text-foreground text-nowrap overflow-auto">
          CORS_ALLOWED_ORIGINS={{ corsAllowedOrigin }}
        </div>
        <DialogDescription class="leading-6">
          支持使用英文逗号分隔多个域名，例如：
          <code class="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">https://a.com,https://b.com</code>
        </DialogDescription>
        <DialogFooter>
          <Button type="button" @click="corsDialogOpen = false">
            我知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Provider>
</template>
