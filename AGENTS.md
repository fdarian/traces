# traces

lightweight observability dashboard — point it at an existing Jaeger (v2) and get a home overview, trace exploration, error aggregation, and per-service filtering. A headless engine (Jaeger access, issue store, ingester) serves a typed oRPC API; the web app is UI only. The UI components ship as a publishable React SDK (`@traces/react`), documented in a Blume site.

## Stack
- Bun + Turborepo + Biome
- Effect.ts 4.1.4 — engine services, config, errors, HTTP server
- oRPC v2 (beta, pinned) — contract-first API between web and engine
- TanStack Start (apps/web)
- shadcn (new-york / zinc) + Tailwind v4 + Geist
- Drizzle ORM rc.5 on Effect adapters (engine only — SQLite default, Postgres optional)

## Workspaces
- `apps/web` — TanStack Start app (dashboard UI; talks only to the engine)
- `apps/docs` — Blume documentation site
- `services/engine` — headless Bun + Effect server: oRPC API, Jaeger access, issue store, ingester
- `packages/contract` — oRPC contract + DTO schemas shared by engine and web
- `packages/core` — domain model, `TraceBackend` interface, Jaeger adapter (pure, no persistence)
- `packages/react` — publishable React SDK (components from day one)
- `apps/cli` — `traces` CLI: unified logs/deploys over Vercel and Railway for agents (provider adapters live in `packages/core/src/logs/`)

Dependency direction: `engine → contract ← web`; `engine → core`. Web never imports the engine or core at runtime.

## Dev loop
1. `docker compose up -d` — starts Jaeger v2 all-in-one (in-memory)
2. `bun run scripts/seed.ts` — seeds realistic multi-service traces
3. `pnpm dev` in `apps/web` — starts web on :3000 and spawns the engine (sticky port, session SQLite db) unless `ENGINE_URL` is set. `pnpm dev` in `services/engine` runs the engine alone; `apps/docs` has its own `pnpm dev`
4. `pnpm turbo run check` — typecheck + lint across the monorepo
5. `docker compose --profile postgres up -d` — optional Postgres; run the engine with `DATABASE_URL=postgresql://traces:traces@localhost:5432/traces`

## Design
- [DESIGN.md](./DESIGN.md) — color tokens, typography, spacing, component idioms

## Notes
- Jaeger memory backend has an error-tag search bug (#8553) — the app never relies on server-side error filtering; error detection is client-side from `status.code == ERROR`
- Web has no server logic: every data call goes through the oRPC client to the engine (see `apps/web/AGENTS.md`). Add a procedure to `packages/contract`, implement it in `services/engine`
- Path alias is `#/*` → `src/*`, never `@/*`
- No `'use client'` anywhere (TanStack Start has no RSC)
- Drizzle models live in `services/engine`, co-located per-domain, never a central `db/models/` folder
- Use `d cc alias` to create CLAUDE.md symlinks from AGENTS.md — never hand-write CLAUDE.md
