# Config

Lookup order:

1. `--config <path>`
2. `traces.json` at the git root, found walking up from the cwd (outside a git repo, only the cwd is checked). `traces init` writes it.
3. `~/.config/traces/config.json` (`$XDG_CONFIG_HOME/traces/config.json`)

`--project <name>` skips `traces.json` and picks that project from the global file. `traces services` reports which file was used (`configSource`: flag | repo | global; `matchedBy` is `repo` for `traces.json`).

## Global config


```json
{
  "projects": {
    "myapp": {
      "matcher": { "type": "git", "repo": "owner/repo" },
      "railway": { "auth": { "keychain": "myapp.railway" } },
      "services": {
        "web": { "provider": "vercel", "project": "myapp-web", "team": "my-team" },
        "api": {
          "provider": "railway",
          "project": "<railway project id>",
          "service": "api",
          "environment": "production"
        }
      }
    }
  }
}
```

- `matcher`: `{"type":"git","repo":"owner/repo"}` or `{"type":"path","path":"~/code/myapp"}`. Path wins over git; the longest path wins.
- Vercel `team` is optional (slug or id).
- Railway `service` and `environment` accept a name or an id; `environment` defaults to `production`.
- Railway auth: `railway.auth` (project level) is required only when a Railway service is used. Two forms:
  - A token: `{"keychain": "<name>"}` (store it with `traces secret set <name>`) or `{"env": "<VAR>"}`, no literal. It is a workspace or account token from railway.com/account/tokens, sent to Railway's GraphQL API over HTTP. Recommended for agents: it grants only Railway API access.
  - `"cli"`: use the logged-in `railway` CLI (`railway login`; the binary must be on PATH). Convenient locally, but the login lets anything that can run `railway` use every railway command, not just this CLI's reads.
  - Without `railway.auth` a Railway service exits 3 with a hint listing both.
- Vercel auth: `VERCEL_TOKEN` or the token the `vercel login` CLI stored.
- `otelService` (optional, any service entry) is the Jaeger service name; it defaults to the service key. An entry with only `{"otelService": "x-data"}` is trace-only: logs, deploys and the log side of errors skip it (naming one there exits 2); the trace side of errors takes it.

Tracing is configured per project, see [tracing](tracing.md).

## Repo traces.json

One project, no `projects` map and no `matcher`: the file's location is the matcher.

```json
{ "name": "myapp", "railway": { "auth": { "keychain": "myapp.railway" } }, "tracing": {}, "services": {} }
```

- `name` is optional and defaults to the git root's folder name; `railway`, `tracing` and `services` take the same shape as a project in the global file. `"$schema"` is allowed and ignored; unknown keys are an error.
- Safe to commit: header secrets and the Railway token are `{"keychain"}` / `{"env"}` refs. Keep literal header values in the global file.
- `traces init` writes `services` (and `tracing` with `--jaeger-url`), never `railway.auth`: add it by hand. See `traces skills get core --ref commands` for what init discovers.
