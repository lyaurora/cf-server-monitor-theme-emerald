# Repository Guide

This repository is a Vue 3 static theme for CF Server Monitor.

## Commands

```bash
bun install
bun run dev
bun run lint
bun run build
bun run preview
```

Use Bun for dependency management. `bun run lint` checks without changing files; use `bun run lint:fix` only when fixes are intended. Validation is ESLint plus the production build; there is no unit test suite yet.

## Architecture

- `src/utils/api.ts` owns CF Server Monitor HTTP access, same-origin request handling, server source registration, and field adaptation. This theme currently supports one same-origin backend.
- `src/utils/init.ts` owns startup order, Turnstile, WebSocket subscriptions, reconnects, and periodic refresh.
- `src/utils/rpc.ts` is a compatibility facade for Emerald chart components; it is not a JSON-RPC transport.
- `src/stores/` remains the UI source of truth.
- `src/components/ui/` is the local reka-ui/shadcn-vue-style component set.
- `src/styles/main.css` contains Tailwind v4 and global design tokens.
- Routing must remain hash-based for static hosting.

## Constraints

- Preserve the existing Cobe Earth and map display modes. Do not reintroduce Naive UI, UnoCSS, or SCSS.
- Preserve relative public asset handling through `src/utils/publicAsset.ts`.
- Keep CF Server Monitor API and WebSocket calls out of views and presentation components.
- A production build must remain deployable as the contents of `dist/` without a server-side renderer.
- When adding API fields, update the adapter rather than leaking CF wire types into components.
