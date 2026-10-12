# @traces/cli

`traces` — unified logs/deploys CLI over Vercel and Railway, built for agents.

## Stack
- Effect v3 + `@effect/cli` + `@effect/platform-bun`

## Dev
- `bun src/main.ts --help` — run the CLI
- `bun check:tsc` / `bun check:lint` / `bun test`

## Notes
- Provider adapters live in `@traces/core` (`packages/core/src/logs/`); this app owns config, project matching, commands, and output.
- All help is hand-written in `src/help.ts`; `COMMAND_HELP` is the one place each command's flags are documented, and `test/help.test.ts` fails when a command's flags and its help disagree. Adding a flag means adding it there.
- Adapter tests, fixtures and fakes live in `packages/core/test`; config, matcher, help and output tests live here.
- stdout carries one record type only (NDJSON when piped); hints and pagination go to stderr.
