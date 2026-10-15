# @traces/core

domain model, `TraceBackend` interface, Jaeger adapter (over Jaeger's `/api/v3` HTTP API), and the logs model with Railway/Vercel log adapters (`src/logs/`).

## Stack
- Effect.ts

## Dev
- `pnpm check:tsc` — typecheck
- `pnpm check:lint` — lint

## Architecture
- `src/index.ts` — the only entry point (`exports` in package.json); new public API is re-exported here
- `src/jaeger.ts` — `makeJaegerBackend({ url, headers })` is the factory and needs `HttpClient`; `JaegerBackendLayer` wires it from `JAEGER_URL` (default `http://localhost:16686`)
- `src/traces/` — trace helpers for the CLI's `trace`, `spans` and `errors` commands, built on `TraceBackend`
  - `span-rows.ts` — `toSpanRows`: depth-first rows of a trace
  - `paging.ts` — window paging for Jaeger search
  - `error-scan.ts` — error-trace scan; groups error spans with `src/issues/fingerprint.ts`, so CLI error groups match issues
- `src/logs/` — provider-neutral log and deployment model; Railway and Vercel adapters are subfolders
- `src/issues/` — issue ingester, fingerprints, and the SQLite/Postgres stores

## Gotchas
- `LogRecord.attrs` values are JSON-decoded and typed `unknown`; narrow before use, don't assume strings
- `LogRecord.traceId` / `spanId` are optional: set only when the attributes carry well-formed ids (`traceId`/`trace_id`, `spanId`/`span_id`; see `src/logs/normalize.ts`)
