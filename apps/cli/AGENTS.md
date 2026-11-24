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
- Long-form guidance (resolution, config, tracing, output/exit codes/limits, recipes) is markdown under `skills/`, one directory per skill (`skills/core/SKILL.md` + `references/*.md`), so each is also a valid Claude Code skill. `traces skills` is the `effect-cli-skills` library (`skills({ cli: 'traces' })` in `main.ts`): `list`, `get <name> [--full | --file <path>]` (frontmatter stripped from SKILL.md), `stub <name>`. The skills are baked in by the Bun macro in `src/skills.macro.ts`, so `skills/` is embedded when the CLI starts or compiles, not read from disk at run time; its errors are mapped to exit 2 in `renderError` (`src/output.ts`). The root description points agents at `traces skills get core`.
- The limits in `skills/core/references/output.md` are literal numbers, update them with `src/limits.ts`. A new reference file needs a line in the References list at the end of `SKILL.md`.
- Railway GraphQL goes through one `RailwayClient` (`packages/core/src/logs/railway/`), picked by `resolveRailwayClient` in `src/resolve.ts` from the project's `railway.auth`: a `SecretRef` token uses `http-client.ts` (HTTP, bearer); `"cli"` uses `cli-client.ts` (spawns the logged-in `railway api`). The token is recommended for agents: the CLI login exposes every `railway` command. `traces services` probes either with the same project read (`checkRailwayAccess`).
- Adapter tests, fixtures and fakes live in `packages/core/test`; config, matcher and output tests live here.
- stdout carries one record type only (text by default, JSON only with `--json`; piped text is plain with full ids, a terminal adds color and 8-char ids); hints and pagination go to stderr.
