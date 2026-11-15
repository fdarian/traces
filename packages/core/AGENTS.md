# @traces/core

Pure domain layer: the trace/issue model, the `TraceBackend` interface, the Jaeger adapter, and helpers (fingerprinting, message normalization, percentiles, service health). It owns no persistence — the issue store lives in `services/engine`.

## Stack
- Effect.ts (4.1.4)

## Dev
- `pnpm check:tsc` — typecheck
- `pnpm check:lint` — lint

## Architecture
- `src/index.ts` — public surface; `src/backend.ts` — `TraceBackend`; `src/jaeger.ts` — `JaegerBackendLayer` (reads `JAEGER_URL`, default `http://localhost:16686`)
- `src/issues/` — issue model and pure functions only
- Consumed at runtime by `services/engine`. `packages/react` only vendors its types (see that package's guard file)
