# @traces/web

TanStack Start app — the traces dashboard UI. No server logic of its own: all data comes from `services/engine` over oRPC.

## Stack
- TanStack Start + React, Nitro (preset: bun)
- `@orpc/client` against the `@traces/contract` types
- shadcn (new-york / zinc) + Tailwind v4 + Geist
- Effect Schema for route search params (`S.toStandardSchemaV1`)

## Dev
- `pnpm dev` — vite on `PORT` (default 3000); also spawns the engine via its dev script unless `ENGINE_URL` is set
- `pnpm build` then `bun .output/server/index.mjs` — production server (`pnpm start` does both)
- `pnpm check:tsc` / `pnpm check:lint`

## Architecture
- `src/routes/` — file-based routing; loaders call `engine` directly
- `src/lib/engine-client.ts` — the oRPC client. SSR hits `ENGINE_URL` directly; the browser hits same-origin `/api/rpc`
- `src/routes/api/rpc/$.ts` — proxy from `/api/rpc/*` to `${ENGINE_URL}/rpc/*`, so the engine never needs to be public or CORS-enabled. The only place raw `fetch` is allowed (byte pass-through)
- `src/lib/engine-url.ts` — `ENGINE_URL` (default `http://localhost:4000`), server-only
- `scripts/dev.ts` — devsess runner; resolves the engine's sticky port from the engine's own session dir

## Conventions
- Client branches on the error `code` (`isDefinedError`, e.g. `TRACE_NOT_FOUND`), never on HTTP status — the RPC protocol only carries statuses for codes the engine maps
- Types come from `@traces/contract`; never import `@traces/engine` or `@traces/core` here
- No `'use client'` anywhere — TanStack Start has no RSC directive
- Path alias is `#/*` → `src/*`, never `@/*`
- `vite.config.ts` adds the pnpm global virtual store to `server.fs.allow`; without it Vite fails with "Failed to load url" for dependencies
