# @traces/cli

`traces` — unified logs/deploys CLI over Vercel and Railway, built for agents.

## Stack
- Effect v3 + `@effect/cli` + `@effect/platform-bun`

## Dev
- `bun src/main.ts --help` — run the CLI
- `bun check:tsc` / `bun check:lint` / `bun test`

## Notes
- Provider adapters live in `@traces/core` (`packages/core/src/logs/`); this app owns config, project matching, commands, and output.
- Top-level `--help` is hand-written in `src/help.ts`; keep it under ~100 lines.
- stdout carries one record type only (NDJSON when piped); hints and pagination go to stderr.
