---
name: core
description: Read logs, deployments, traces and errors of a deployed service (Vercel, Railway, Jaeger) with the traces CLI. Use when debugging production or preview behaviour, checking whether a fix deployed, or finding what is failing and why.
---

# traces

Read logs, deployments and traces from Vercel, Railway and Jaeger through one CLI. stdout carries records (compact lines on a TTY, NDJSON when piped or with `--json`); notes, hints and pagination go to stderr.

Flags and examples: `traces <command> --help`. Deeper topics are listed under References at the end.

## Resolution

The project is matched from the cwd's git remote (or path) against the config; `--project <name>` overrides. The service is the positional argument, and may be omitted when the project has exactly one (`traces errors` without one covers all services). Global flags may come before the command. Run `traces services` to see what matched and whether each provider is authenticated.

Global flags: `--project <name>`, `--env <name>` (Railway environment name, or Vercel target: production | preview), `--config <path>`, `--json`.

## Commands

| Command | What it does |
| --- | --- |
| `traces services` | matched project, services, provider auth status |
| `traces logs [service]` | runtime logs, oldest to newest (also `--build`, `--http`) |
| `traces deploys [service]` | deployments: status, commit sha, branch, time, url |
| `traces errors [service]` | error logs and error spans grouped by fingerprint, most frequent first |
| `traces spans [service]` | search traces of a service in Jaeger, oldest to newest |
| `traces trace <traceId>` | show one trace as a span tree from Jaeger |
| `traces secret set\|delete <name>` | store or remove a keychain secret (tracing headers, the Railway token) |

## Recipes

| Goal | Commands |
| --- | --- |
| slow endpoint | `traces spans web --min-duration 1s` |
| failing log -> its trace | `traces logs web --level error --json` (copy a record's `traceId`), then `traces trace <traceId>` |
| what is failing anywhere | `traces errors --since 1d` (all services, logs and error spans, one list) |
| error group -> its trace | `traces errors --source traces --since 1d` (run a group's hint: `traces trace <id>`) |
| why is prod 500ing | `traces errors api --since 1h`, then `traces logs api --level error --grep "<sample from above>"`, then `traces logs api --http --level error` (5xx requests) |
| did my fix deploy | `traces deploys api` (compare the sha with `git rev-parse HEAD`; no commit shown: compare `createdAt` with the time of the push) |
| build failed | `traces logs web --build` |
| watch while reproducing | `traces logs api -f` |
| what happened at 14:05 | `traces logs api --since 2026-10-12T14:00:00Z --until 2026-10-12T14:10:00Z` |
| one bad deployment | `traces deploys api`, then `traces logs api --deploy <id> --level error` |
| older than this page | run the command from the `more:` line |
| preview or staging | `traces logs web --env preview` / `traces logs api --env staging` |

## References

Load one with `traces skills get core --ref <name>`, or all of them after this page with `traces skills get core --full`.

- `config`: the config file, project matching, services, and how provider credentials and tracing headers are set up
- `tracing`: Jaeger tracing: `tracing.url`, service names, attribute search, error detection from spans
- `output`: stdout vs stderr, NDJSON, exit codes, pagination, limits and provider retention
- `commands`: per-command output fields and notes for every command
