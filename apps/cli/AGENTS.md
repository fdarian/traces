# @traces/cli

`traces` — unified logs/deploys CLI over Vercel and Railway, built for agents.

## Stack
- Effect v4 (`effect/cli`, `effect/process`, `effect/http`, `effect/FileSystem`) + `@effect/platform-bun`

## Dev
- `bun src/main.ts --help` — run the CLI
- `bun check:tsc` / `bun check:lint` / `bun test`

## Notes
- Provider adapters live in `@traces/core` (`packages/core/src/logs/`); this app owns config, project matching, commands, and output.
- Help is the Effect framework's own: each command's description, flag descriptions and examples live on its `Command` / `Flag` / `Argument` in `src/commands/*.ts` (and `globalOptions` in `src/resolve.ts`). Only `--help` is a built-in flag, and `parseErrorPresenter` (`src/output.ts`) keeps parse errors to the one-line `error:` + `hint:` on stderr with no usage block.
- Long-form guidance (resolution, config, tracing, output/exit codes/limits, recipes) is markdown under `skills/`; the limits in `skills/references/output.md` are literal numbers, update them with `src/limits.ts`.
- Adapter tests, fixtures and fakes live in `packages/core/test`; config, matcher and output tests live here.
- stdout carries one record type only (NDJSON when piped); hints and pagination go to stderr.
