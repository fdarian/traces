# Output, exit codes, limits, retention

## Output

stdout: compact lines on a TTY; NDJSON when piped or with `--json` (one record per line: LogRecord, Deployment, error group, TraceRow or SpanRow; fields are stable). When older records exist, stderr gets `more: <full command with --cursor>`. Errors are one stderr line plus a `hint:` line (parse errors too, with no usage block). Empty results print a note on stderr, with the retention caveat when the window starts past it, and exit 0.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | runtime/provider error |
| 2 | usage/config error |
| 3 | auth error |

## Limits

- `logs --limit`: default 100, max 1000 per page.
- `deploys --limit`: default 10, max 100 per page.
- `errors` has no `--limit`: it reads at most 2000 error logs per service, and fetches at most 200 error traces per service.

## Retention

Railway keeps logs 3d (Free), 7d (Hobby), 30d (Pro). Vercel runtime logs: 1h (Hobby), 1d (Pro), 30d (Observability Plus). An empty result older than that is not "no errors".
