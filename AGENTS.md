# traces

lightweight observability dashboard — point it at an existing Jaeger (v2) and get a home overview, trace exploration, error aggregation, and per-service filtering. The UI components ship as a publishable React SDK (`@traces/react`), documented in a fumadocs site.

## Stack
- Bun + Turborepo + Biome
- Effect.ts — services, config, errors, runtime
- TanStack Start (apps/web)
- shadcn (new-york / zinc) + Tailwind v4 + Geist
- TanStack Form + Valibot
- Drizzle ORM (pluggable — SQLite default, Postgres optional)

## Workspaces
- `apps/web` — TanStack Start app (dashboard)
- `apps/docs` — fumadocs documentation site
- `packages/core` — domain model, `TraceBackend` interface, Jaeger adapter
- `packages/react` — publishable React SDK (components from day one)

## Dev loop
1. `docker compose up -d` — starts Jaeger v2 all-in-one (in-memory)
2. `bun run scripts/seed.ts` — seeds realistic multi-service traces
3. `bun dev` (in `apps/web` or `apps/docs`) — starts the app
4. `bun turbo run check` — typecheck + lint across the monorepo

## Design
- [DESIGN.md](./DESIGN.md) — color tokens, typography, spacing, component idioms

## Notes
- Jaeger memory backend has an error-tag search bug (#8553) — the app never relies on server-side error filtering; error detection is client-side from `status.code == ERROR`
- Server functions live in dedicated `*.server-fn.ts` files — never co-mixed with components
- Path alias is `#/*` → `src/*`, never `@/*`
- No `'use client'` anywhere (TanStack Start has no RSC)
- Drizzle models are co-located per-domain, never a central `db/models/` folder
- Use `d cc alias` to create CLAUDE.md symlinks from AGENTS.md — never hand-write CLAUDE.md
