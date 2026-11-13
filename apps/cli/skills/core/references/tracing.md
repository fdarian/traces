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
```

`traces services` shows the URL, each referenced secret as present or missing, whether the URL answers (reachable, unauthorized or error), and the `otelService` per service, flagging any Jaeger does not report. A missing secret or env var exits 3 with the fix as a hint.
