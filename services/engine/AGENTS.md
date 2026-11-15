# @traces/engine

Headless Bun server behind the dashboard: serves the oRPC API at `/rpc/*` and `/health`, reads traces from Jaeger through `@traces/core`, owns the issue store, and runs the error ingester from boot. Usable without the web app (any oRPC client built from `@traces/contract`). It has no auth — keep it behind the web proxy or a private network.

## Stack
- Effect 4.1.4 + `@effect/platform-bun`; oRPC v2 `@orpc/server` + `@orpc/effect`
- Drizzle `1.0.0-rc.5` on Effect adapters (`effect-sqlite-bun`, `effect-postgres`)

## Dev
- `pnpm dev` — devsess runner (`scripts/dev.ts`): `bun --watch`, sticky port named `engine`, session-local `TRACES_DB` unless `TRACES_DB`/`DATABASE_URL` is set
- `pnpm start` — `bun src/main.ts`
- `pnpm test` — bun tests (stores run on temp SQLite; the Postgres store has no tests)
- `pnpm check:tsc` / `pnpm check:lint`
- Migrations: `pnpm exec drizzle-kit generate --config drizzle.config.<sqlite|pg>.ts` (or `pnpm db:generate:sqlite|pg`) from this directory. Use `pnpm exec`, not bun, to run drizzle-kit. Commit rules: `code-db-isolate-migrations` skill

## Architecture
- `src/server.ts` — `HttpRouter` layers: `/health`, `/rpc/*`; services and ingester wired here. Env: `PORT` (4000), `HOST` (`0.0.0.0`), `JAEGER_URL`, `TRACES_DB` (`./traces.db`), `DATABASE_URL` (presence selects Postgres), `INGEST_*`
- `src/rpc/` — `implement(contract)` router, error mapping, fetch-handler glue
- `src/{traces,issues,home}/` — one router per contract domain; `issues/` also holds the stores, ingester, and `drizzle/schema-{sqlite,pg}.ts`
- `drizzle/{sqlite,pg}/` — generated migrations, applied by the store layers at boot

## Gotchas
- Effect 4.1.4 differs from the `code-ts-effect` skill: HTTP is `effect/http` (no `unstable/*`), and Config constructors are capitalized (`Config.String`, `Config.Number`, `Config.Port`)
- oRPC v2 is beta; the `@orpc/*` versions are pinned exactly in the workspace catalog. Don't bump to `latest`
- RPC procedures default to POST. The protocol ignores a contract error's `status` unless it is in `errorStatusMap`, built from `definedErrors` in `src/rpc/handler.ts` — add new error groups there. Core tagged errors are not auto-mapped — map them in `src/rpc/errors.ts`
- SQLite `PRAGMA foreign_keys = ON` runs after migrations, on purpose: rebuild migrations drop tables and would cascade-delete occurrences if it were on earlier. `@effect/sql-sqlite-bun` leaves it off by default
- Schema files are loaded by drizzle-kit under Node: never import `bun:sqlite`, `effect`, or the Effect adapters in `drizzle/schema-*.ts`
- `issues.fingerprint` is an explicit `uniqueIndex` in the SQLite schema (not `.unique()`) so drizzle-kit v1 doesn't rebuild the table into an inline UNIQUE constraint. After any schema edit, `generate` for both dialects should produce no unintended diff
- The SQLite and Postgres stores are near-duplicates; change both
