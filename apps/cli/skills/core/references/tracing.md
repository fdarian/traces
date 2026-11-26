# Tracing

Per project, optional; trace commands (`spans`, `trace`, the trace side of `errors`) exit 2 without it.

```json
"tracing": {
  "provider": "jaeger",
  "url": "https://host/optional/base/path",
  "headers": { "X-API-Key": { "keychain": "myapp.jaeger" } }
}
```

- `url`: the Jaeger query base URL as exposed to you: a subdomain or proxied path that serves `/api/v3` and `/api/traces` (a reverse-proxy path prefix is kept). `traces services` verifies the URL with one request.
- Header values: a literal string, `{"env": "NAME"}` or `{"keychain": "<name>"}`. Secrets are read only when a trace command runs, never by log commands.

## One-time secret setup

Run by the user (agents cannot answer the hidden prompt):

```
traces secret set myapp.jaeger
pbpaste | traces secret set myapp.jaeger
pbpaste | traces secret set myapp.jaeger --insecure-storage
```

The last form writes `~/.config/traces/secrets.json` (plain text, mode 0600) instead of the keychain: use it over SSH or headless, where the keychain cannot prompt. A name in the file wins over the keychain.

`traces services` shows the URL, each referenced secret as present (and from which store) or missing, whether the URL answers (reachable, unauthorized or error), and the `otelService` per service, flagging any Jaeger does not report. A missing secret or env var is reported in that output (the `traces secret set <ref>` fix on the next line) and the command still exits 0.
