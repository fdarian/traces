# Commands: output and notes

Per-command record shape and behaviour notes. Flags and examples: `traces <command> --help`. On a pipe or with `--json`, stdout is NDJSON.

## traces services

Show the project matched for the current directory, its services, whether each provider is authenticated, and the tracing setup (URL, header secrets, otelService) with a live reachability check of the tracing URL.

Usage: `traces services [flags]`

### Output

one record per service: configPath, project, matchedBy (flag | path | git), service, provider (absent for trace-only), ref (the config entry), auth {status: ok | missing | invalid, detail} (absent for trace-only), otelService (the Jaeger service name; set when the project has tracing or the entry names one), tracing (when the project has it) {provider, url, headers[], check}, check being {status: reachable, services[]} (the Jaeger service names) | {status: unauthorized} | {status: error, detail}, and otelInJaeger (boolean, only when check is reachable): whether Jaeger reports the otelService. Each tracing header is {name, source: literal | env | keychain, ref, status: present | missing | error, detail?}; literal headers carry no ref or status. Values are never printed.

### Notes

- Run this first when another command says no project matches or auth fails.
- Auth check: Railway runs `railway whoami`; Vercel validates the token against the API.
- With a `tracing` block, one `/api/v3/services` request (5s timeout) checks the URL: reachable, unauthorized (credentials rejected), or error with a short reason (an HTML page, a redirect, a missing secret, no answer). A failed check still exits 0. Every service whose otelService Jaeger does not report is listed as `<service> → <otelService>: not in Jaeger`; a wrong name there is why `traces spans` comes back empty. Projects without `tracing` make no request.
- Tracing: `traces secret set <ref>` fixes a missing keychain secret; an env header is `missing` until that variable is exported. Reading keychain entries here may prompt macOS for access.

## traces logs

Print logs for one service, oldest to newest. Default: runtime logs of the last 1h.

Usage: `traces logs [service] [flags]`

### Output

LogRecord per line: ts, appTs?, service, provider, environment, deploymentId?, source (runtime | build | http), level (debug | info | warn | error | fatal | unknown), message, request? {method, path, status, durationMs?, requestId?}, traceId?, spanId?, attrs. Compact text on a TTY.

### Notes

- When older records exist, stderr gets `more: <full command with --cursor>`; run it for the next page.
- An empty result exits 0 and says so on stderr. When the window starts past the shortest provider retention (Railway 3d, Vercel 1h), the note adds the retention caveat: past that window, empty does not mean "no errors".
- A trace-only service (config entry with only `otelService`) has no logs: exit 2 with "<service> has no log provider; it's trace-only".
- --build and --http are mutually exclusive; --follow works with runtime and --http, not with --build or --cursor.
- Vercel: runtime records are the app's own log lines. A 5xx with no log line only shows up with --http; use `--http --level error` (on --http, level comes from the status: 5xx error, 4xx warn).
- Vercel build logs: stderr lines are level error (tool warnings included); fatal events are fatal.
- Railway has no fatal level, so --level fatal alone matches nothing there.
- --cursor continues the original window; repeat the original flags exactly as the `more:` line prints them.
- --grep is a literal substring match on the message only: it is not a regex and does not search attrs. Matching is case-insensitive on Railway and Vercel.
- `ts` is the provider receive (ingest) time: on Railway it runs a few seconds after the app logged the line. Paging, --since and --until use it. `appTs` (ISO, UTC) is the app's own time, set only when `attrs.timestamp` is an ISO-8601 string with a zone (a number is left in attrs); use it to line a log up against span times from `traces trace`. TTY lines show `ts`.
- `attrs` values are JSON-decoded once on Railway: Effect loggers' `annotations` and `spans` are real objects, and a value that is not valid JSON stays a string.
- `traceId` / `spanId` are set only when the record carries a 32-hex trace id (16-hex span id): Vercel from the request row, Railway from `attrs.annotations.traceId` or a top-level `traceId` / `trace_id` attr. A TTY shows `trace=<first 8>`.
- On a TTY, times are UTC with a Z suffix, and the date is prefixed when the window spans more than one day. JSON `ts` is always the full ISO timestamp.
- -f prints `following <service> ...` once on stderr; stdout stays NDJSON.

## traces deploys

List deployments of a service, newest first: status, commit, branch, time, url.

Usage: `traces deploys [service] [flags]`

### Output

Deployment per line: id, service, provider, environment, status (queued | building | deploying | ready | failed | canceled | crashed | removed | sleeping | unknown), rawStatus, createdAt, url?, commit? {sha, message?, branch?}.

### Notes

- When older records exist, stderr gets `more: <full command with --cursor>`; run it for the next page.
- A trace-only service (config entry with only `otelService`) has no deployments: exit 2.
- `commit` is absent when the provider did not record one, e.g. Railway deploys made from the CLI or from an image.
- Did a fix deploy? Compare the newest `ready` deployment's sha with `git rev-parse HEAD`. Without a commit, compare its `createdAt` with the time of the push.
- Vercel lists the deployments of --env (default production); Railway lists the service's environment.

## traces errors

Group error and fatal logs, plus error spans from Jaeger when the project has `tracing`, by fingerprint, most frequent first. Start here for "what is failing".

Usage: `traces errors [service] [flags]`

### Output

one group per line: source (logs | traces), fingerprint, service, count, firstSeen, lastSeen, deploymentIds (always empty for trace groups), sample (full message of the first occurrence; `<exception type>: <message>` for traces), traceId (optional; the first record that carries one, or the newest sampled trace), traceIds (trace groups only: up to 3 distinct traces), provider (railway | vercel | jaeger), environment (absent for trace groups), hint, partial. `hint` is a ready-to-run `traces logs ... --grep` command for a log group and `traces trace <traceId>` for a trace group. On a TTY, trace groups carry a `[traces]` marker.

### Notes

- Without a service, every service of the project is covered (fetched concurrently); each group keeps its `service` and all groups, log and trace, are sorted by count. A trace-only service (no `provider`) is skipped on the log side and taken by the trace side; naming one exits 2 when the trace side will not run (no `tracing`, or --source logs).
- Trace groups: when the project has `tracing`, each service's `otelService` is searched in the window, the full trace of every trace with error spans is fetched, and the error spans of that service are fingerprinted like Issues do (exception type, normalized message and top in-app frame; an error span without an exception event groups by span name and status message). A log group and a trace group for the same failure stay separate; match them by the traceId.
- At most 200 error traces are fetched per service, newest first, and at most 1000 traces are read to find them. When either cap leaves older traces unread, every trace group of that service has `partial: true` and stderr says so. Narrow --since for exact counts.
- If one service fails (auth, provider error) while the others succeed, the successful groups are still printed, stderr gets `error: <service>: ...` per failed log service (`error: <service> (traces): ...` for the trace side, `error: tracing: ...` when the tracing secret or backend cannot be set up), and the exit code is 1.
- Messages are grouped by their first line with ids, hex, quoted strings and numbers collapsed.
- At most 2000 error logs are read. When the cap is hit, counts are partial (newest 2000 only): every group of that service has `partial: true` and stderr says so (the cap is per service). Narrow --since for exact counts.
- An empty result exits 0 and says so on stderr. When the window starts past the shortest provider retention (Railway 3d, Vercel 1h), the note adds the retention caveat: past that window, empty does not mean "no errors".
- Vercel: only logged errors are counted; 5xx responses without a log line are not (see `traces logs --http`).

## traces spans

List traces that touch a service's otelService, one summary per trace. Default: the last 1h. Needs a `tracing` block in the config (see [tracing](tracing.md)).

Usage: `traces spans [service] [flags]`

### Output

TraceRow per line: traceId, rootService, rootOperation, startTs (ISO, nanosecond precision), durationMs, spanCount, errorSpanCount (absent when the backend does not report it), services[]. On a TTY: `02:55:09.123Z 412ms ERR×2 mockingbird-web GET /api/x  a042d0ba…` (ERR×n only when the trace has error spans; the last column is the first 8 of the traceId).

### Notes

- When older records exist, stderr gets `more: <full command with --cursor>`; run it for the next page.
- Searches the service's `otelService` (default: the service key); a trace-only service works. Traces are summarised whole: `services` lists every service in the trace, not just the one searched.
- Pages go backwards: each page is the newest traces left in the window, printed oldest to newest. The `more:` cursor carries the window start, so a relative --since cannot drift; repeat the other flags exactly as the line prints them.
- --errors asks Jaeger for error-tagged traces and checks each one's errorSpanCount > 0; when Jaeger returns nothing, or has no /api/traces, it pages the unfiltered window and counts on the client. It reads pages until --limit error traces are found, the window ends, or 1000 traces were read; at the cap stderr says so and `more:` continues the scan. A backend that reports no error counts fails with exit 1.
- --attr is searched through Jaeger's legacy `/api/traces`, because the v3 API ignores attribute filters. If tracing.url does not serve it (404 or 405), --attr exits 1 saying so; drop --attr or point tracing.url at the Jaeger query host.
- An empty result exits 0 and says so on stderr. An empty result for a service Jaeger has never seen usually means a wrong otelService: `traces services` shows the name searched.
- Jaeger keeps traces only as long as its storage backend does (in-memory Jaeger drops them on restart): an empty old window is not proof of no traffic.
- On a TTY, times are UTC with a Z suffix, and the date is prefixed when the window spans more than one day. JSON `startTs` is always the full ISO timestamp.

## traces trace

Fetch every span of one trace, ordered depth first. No service is needed; the project is still resolved for its `tracing` block (see [tracing](tracing.md)).

Usage: `traces trace <traceId> [flags]`

### Output

SpanRow per line, depth first with children by start time: traceId, spanId, parentSpanId (absent on roots), depth, service, name, kind (server | client | producer | consumer | internal | unspecified), startTs (ISO, nanosecond precision), durationMs, status (ok | error | unset), statusMessage (optional), attrs (span attributes as an object), events[] ({name, ts, attrs}), exception ({type, message, stacktrace?}, optional; moved out of the first exception event, so events does not repeat the stacktrace; later exception events stay in events). On a TTY: an indented tree, `+offset duration service name`, offset from the earliest span; error spans add ERR, then the exception type and message and its top 3 stack frames.

### Notes

- A span whose parent is not in the trace (partly retained or still arriving) is a root at depth 0 and keeps its parentSpanId.
- Span durations are whole milliseconds: spans under 1ms show 0ms.
- A trace Jaeger does not have exits 1 with a hint. Jaeger keeps traces only as long as its storage backend does (in-memory Jaeger drops them on restart), so an old id may have expired.
- A string that is not a trace id exits 2 before any request; the 8-char `trace=` prefix on a log line is too short, use `traces logs <service> --json` for the full id.

## traces secret

Manage the OS-keychain secrets that tracing headers refer to as {"keychain": "<name>"}. Values are stored under the keychain service `traces` and are never printed or logged.

Usage: `traces secret set|delete <name>`

### Output

no records on stdout. stderr confirms what was stored or deleted.

### Notes

- `set` reads the value from a hidden prompt on a terminal, or from stdin when piped (one trailing newline is dropped). An empty value is refused.
- Agents cannot answer the hidden prompt: the user runs `traces secret set <name>` once; after that every trace command reads the secret itself.
- `delete` of a name that does not exist exits 0 and says so on stderr.
- There is no `list`: the keychain cannot be enumerated. `traces services` shows present or missing for every secret the config references.
- A trace command with a missing secret exits 3 and prints the `traces secret set <name>` to run.
- Takes no global flags.
