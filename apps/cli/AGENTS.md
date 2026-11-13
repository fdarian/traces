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
- Long-form guidance (resolution, config, tracing, output/exit codes/limits, recipes) is markdown under `skills/`, one directory per skill (`skills/core/SKILL.md` + `references/*.md`), so each is also a valid Claude Code skill. `traces skills` (`src/commands/skills.ts`) serves them: `list`, `get <name> [--full | --ref <name>]` (raw markdown, frontmatter stripped), `path [name]`. The root description points agents at `traces skills get core`. The skills root is found relative to the source file, not the cwd; frontmatter is parsed by hand (`key: value` lines only, no YAML dependency).
- The limits in `skills/core/references/output.md` are literal numbers, update them with `src/limits.ts`. A new reference file needs a line in the References list at the end of `SKILL.md`.
- Railway is called over its GraphQL API with the project's `railway.token` (a `SecretRef`, resolved by `resolveRailwayToken` in `src/resolve.ts`); the `railway` CLI is never spawned.
- Adapter tests, fixtures and fakes live in `packages/core/test`; config, matcher and output tests live here.
- stdout carries one record type only (NDJSON when piped); hints and pagination go to stderr.
