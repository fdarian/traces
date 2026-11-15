# @traces/contract

The wire contract between `services/engine` and `apps/web`: an oRPC contract router plus Effect Schema DTOs and typed error definitions. Standalone on purpose so web (and any third-party client) depends on it without pulling in the engine's drizzle/SQL stack. Source-only: `main` points at `src/index.ts`, no build step.

## Stack
- `@orpc/contract` + `@orpc/effect` (v2 beta, pinned exactly in the workspace catalog) and Effect 4.1.4 Schema

## Dev
- `pnpm check:tsc` / `pnpm check:lint` / `pnpm test`

## Architecture
- `src/index.ts` — `contract = oc.router({ traces, issues, home })`; re-exports everything
- `src/{traces,issues,home}.ts` — per-domain procedures and schemas
- `src/errors.ts` — typed error codes (`JAEGER_UNREACHABLE`, `JAEGER_BAD_RESPONSE`, `TRACE_NOT_FOUND`, `ISSUE_NOT_FOUND`)

## Gotchas
- `import '@orpc/effect/extensions/schema'` must stay the first import in `src/index.ts`; it lets `.input/.output/.errors` accept Effect Schemas (they are not Standard Schema natively)
- Procedures are POST by default over the RPC protocol
- Clients branch on the error `code` (`isDefinedError`), not HTTP status. The `status` here is applied only through the engine's `errorStatusMap`; the RPC protocol answers 400 for unmapped codes
- Adding a procedure or error: define it here, implement it in `services/engine`, and register new error groups in `definedErrors` in the engine's `src/rpc/handler.ts`
- DTOs are plain serialized shapes (timestamps are epoch-ms numbers); don't import `@traces/core` or engine code here
