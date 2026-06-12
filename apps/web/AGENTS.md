# @traces/web

TanStack Start app — the traces observability dashboard.

## Stack
- TanStack Start + React
- Effect.ts (ManagedRuntime for framework integration)
- shadcn (new-york / zinc) + Tailwind v4 + Geist
- TanStack Form + Valibot

## Dev
- `bun dev` — start dev server
- `bun check:tsc` — typecheck
- `bun check:lint` — lint

## Architecture
- `src/routes/` — file-based routing
- `src/server/` — Effect services and runtime
- `server/` — Nitro middleware (auth, well-known endpoints)
- `vite.config.ts` — TanStack Start + Nitro (preset: bun)

## Conventions
- Server functions live in dedicated `*.server-fn.ts` files. **Never** mix them with components, hooks, or client utilities in the same file.
- No `'use client'` anywhere — TanStack Start has no RSC directive.
- Path alias is `#/*` → `src/*`, never `@/*`.
