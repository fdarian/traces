# Config

Location: `~/.config/traces/config.json` (`$XDG_CONFIG_HOME/traces/config.json`, or `--config <path>`).

```json
{
  "projects": {
    "myapp": {
      "matcher": { "type": "git", "repo": "owner/repo" },
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
- Auth: `railway login`; Vercel uses `VERCEL_TOKEN` or the token the `vercel login` CLI stored.
- `otelService` (optional, any service entry) is the Jaeger service name; it defaults to the service key. An entry with only `{"otelService": "x-data"}` is trace-only: logs, deploys and the log side of errors skip it (naming one there exits 2); the trace side of errors takes it.

Tracing is configured per project, see [tracing](tracing.md).
