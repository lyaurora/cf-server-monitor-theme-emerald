<h1 align="center">Emerald Theme for CF Server Monitor</h1>

<p align="center">基于 Vue 3 + Vite + reka-ui + Tailwind CSS v4 构建的 CF Server Monitor主题</p>

![preview](/docs/preview.png)

## 功能

- 卡片和表格两种节点视图
- 多分组、搜索、地区旗帜和操作系统图标
- CPU、内存、磁盘、流量、网络和 Ping 历史图表
- 世界地图节点分布，支持在线/离线散点与计数
- `CF Server Monitor` WebSocket 实时更新与断线重连
- 单后端 Turnstile 验证
- 深色、浅色和跟随系统主题

## 主题设置

拷贝&调整下方参数，将其填入到 **CF Server Monitor** 后端设置页面的 `主题自定义配置 JSON` 中并保存。

背景优先使用 CFSM 原生配置，深色模式保留原有深色底。没有原生背景时才使用主题自定义背景；只配置一个背景地址时，深浅色模式共用。

```
{
  "configuration": [
    {
      "key": "defaultThemeMode",
      "value": "auto",
      "options": "auto,light,dark",
      "description": "访客的默认主题模式：auto 跟随系统，light 浅色，dark 深色（用户手动切换后以用户选择为准）"
    },
    {
      "key": "defaultViewMode",
      "value": "card",
      "options": "card,list",
      "description": "节点列表的默认显示模式"
    },
    {
      "key": "alertEnabled",
      "value": "false",
      "options": "",
      "description": "在首页显示自定义公告"
    },
    {
      "key": "alertTitle",
      "value": "",
      "options": "",
      "description": "公告的标题内容"
    },
    {
      "key": "alertContent",
      "value": "",
      "options": "",
      "description": "公告的详细内容（支持简单 Markdown 格式）"
    },
    {
      "key": "earthViewMode",
      "value": "maps",
      "options": "earth,earth-stop,maps,cards,hide",
      "description": "earth：自转地球；earth-stop：静止地球；maps：点状地图；cards：仅显示头部卡片；hide：隐藏整个头部"
    },
    {
      "key": "visitorInfoCardEnabled",
      "value": "true",
      "options": "",
      "description": "显示访客来源、设备和浏览器信息卡片"
    },
    {
      "key": "hideAdminEntryWhenLoggedOut",
      "value": "false",
      "options": "",
      "description": "隐藏顶部管理后台按钮"
    },
    {
      "key": "disablePageAnimation",
      "value": "false",
      "options": "",
      "description": "减少页面过渡动画效果，提升访问速度和响应性"
    },
    {
      "key": "offlineNodesLast",
      "value": "false",
      "options": "",
      "description": "开启后离线节点默认显示到所有节点最后"
    },
    {
      "key": "icpEnabled",
      "value": "false",
      "options": "",
      "description": "在页脚显示网站备案号"
    },
    {
      "key": "icpNumber",
      "value": "",
      "options": "",
      "description": "网站备案号（如：京ICP备12345678号）"
    },
    {
      "key": "icpUrl",
      "value": "https://beian.miit.gov.cn/",
      "options": "",
      "description": "点击备案号跳转的链接地址"
    },
    {
      "key": "policeEnabled",
      "value": "false",
      "options": "",
      "description": "在页脚显示公安备案信息"
    },
    {
      "key": "policeNumber",
      "value": "",
      "options": "",
      "description": "公安备案号（如：京公网安备 11010502000000号）"
    },
    {
      "key": "policeUrl",
      "value": "",
      "options": "",
      "description": "点击公安备案号跳转的链接地址，留空则不跳转"
    },
    {
      "key": "backgroundEnabled",
      "value": "false",
      "options": "",
      "description": "启用后可设置自定义图片或视频作为页面背景"
    },
    {
      "key": "backgroundType",
      "value": "image",
      "options": "image,video",
      "description": "选择背景类型：图片或视频"
    },
    {
      "key": "lightBackgroundUrl",
      "value": "",
      "options": "",
      "description": "亮色模式下的背景图片/视频 URL"
    },
    {
      "key": "darkBackgroundUrl",
      "value": "",
      "options": "",
      "description": "暗色模式下的背景图片/视频 URL"
    },
    {
      "key": "backgroundBlur",
      "value": "0",
      "options": "",
      "description": "背景的高斯模糊半径（单位：px），0 表示不模糊"
    },
    {
      "key": "backgroundOverlay",
      "value": "0",
      "options": "",
      "description": "背景遮罩强度（-100 到 100）：负数降低背景透明度，0 表示关闭，正数为黑色遮罩，绝对值越大效果越明显"
    }
  ]
}
```

## 开发

本地卡片调整：中部采用 Glassmorphism 的三列双行结构；下方三条线路各自显示最新延迟、最近两小时的加权平均丢包及历史条。登录后点击线路名称可换线，结果合并保存至站点 `theme_options.pingLinesByNode`，需要后端支持 `POST /api/theme_options`。列表沿用相同选线，只显示三个最新延迟，悬浮显示线路名。后端历史不足两小时时缺失部分留空，不额外轮询节点历史。

```bash
bun install
cp .env.example .env
bun run dev
```

`.env` 示例：

```dotenv
API_BASE=https://monitor.example.com
BASE_PATH=./
```

`API_BASE` 支持用英文逗号配置多个 Worker。开发模式会把同源 `/api` 请求代理到单个 `API_BASE`，避免本地 CORS 限制。

生产环境采用同源部署：由 Web 服务器（如 Nginx）托管 `dist/` 静态文件，并将 `/api`、`/flags`、`/os-icons` 和 `/api/ws` 反向代理到 CF Server Monitor Worker。

## 构建

```bash
bun run lint
bun run build
bun run preview
```

自定义域名和其他静态平台通常保留 `BASE_PATH=./` 即可。

版本 `1.2.8.1` 沿用 `main` 源码分支和 `build` 产物分支。更新 `package.json` 版本并推送后，现有工作流会把构建结果发布到 `build`；按 CFSM 规范，产物根目录仅包含 `index.html` 和 `assets/`，国旗及系统图标由 CFSM 提供。

### 主题开发文档：

- [CF-Server-Monitor项目地址](https://github.com/huilang-me/CF-Server-Monitor)
- [开发指南](https://github.com/huilang-me/CF-Server-Monitor/blob/main/develop.md)
- [前端API文档](https://github.com/huilang-me/CF-Server-Monitor/blob/main/theme-develop.md)
- [后端API文档](https://github.com/huilang-me/CF-Server-Monitor/blob/main/API.md)

## 运行时约定

- 路由：`/#/`、`/#/server/:id`
- 后端管理入口：`${origin}/admin#/admin`
- 后端地址为当前页面 origin（同源部署）
- 匿名用户最多可查询近 24 小时的历史数据；登录后最多可查询近 7 天，无需额外的长历史开关

## 致谢

- [Tokinx/komari-theme-emerald](https://github.com/Tokinx/komari-theme-emerald)
- [huilang-me/CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)
- [huilang-me/CF-Server-Monitor-theme](https://github.com/huilang-me/CF-Server-Monitor-theme)

## License

[MIT](./LICENSE)
