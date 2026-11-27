import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { getApiAssetUrl } from '@/utils/api'
import { registerLocalIcons } from '@/utils/icons'
import App from './App.vue'
import router from './router'

import './styles/main.css'

registerLocalIcons()

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.href = getApiAssetUrl('favicon.ico')
document.head.appendChild(favicon)

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.use(router)

app.mount('#app')
