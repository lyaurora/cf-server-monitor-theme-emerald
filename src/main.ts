import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { getApiAssetUrl } from '@/utils/api'
import { message } from '@/utils/message'
import App from './App.vue'
import router from './router'

import './styles/main.css'

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.href = getApiAssetUrl('favicon.ico')
document.head.appendChild(favicon)

window.$message = message

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.use(router)

app.mount('#app')
