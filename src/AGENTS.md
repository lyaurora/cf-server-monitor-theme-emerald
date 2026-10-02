# Source Guide

- Use Vue 3 Composition API with `<script setup lang="ts">`.
- `App.vue` owns the shell and calls `initApp()` / `destroyInitManager()`.
- Hash routes are `/` and `/server/:id`.
- `stores/app.ts` owns theme and UI preferences; `stores/nodes.ts` owns normalized node state.
- `utils/api.ts` is the CF Server Monitor HTTP and adaptation boundary.
- `utils/init.ts` owns startup, Turnstile, WebSocket and refresh lifecycle.
- `utils/rpc.ts` contains normalized node/history types; charts query history through typed functions in `utils/api.ts`.
- Use existing reka-ui wrappers under `components/ui/` and Tailwind utilities.
- Use `publicAsset()` for public files so subpath deployments keep working.
- Preserve the existing Cobe Earth and map display modes. Do not add Naive UI, UnoCSS, SCSS, or browser-history routing.
- Validate with `bun run lint` and `bun run build`.
