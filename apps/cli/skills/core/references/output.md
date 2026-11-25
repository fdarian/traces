# Output, exit codes, limits, retention

## Output

stdout: compact text by default, piped or on a terminal; `--json` prints JSON instead, one record per line (LogRecord, Deployment, error group, TraceRow or SpanRow; fields are stable), except `traces services`, which prints one document. A terminal only adds color and shortens ids to 8 characters (`trace=a042d0ba`, `a042d0ba…`); piped text has no ANSI codes and full ids. `traces errors` text shows only a one-line sample (the first non-empty line, with `(+N lines)` when the sample has more) and times trimmed to milliseconds; `--json` has the full sample and timestamps. When older records exist, stderr gets `more: <full command with --cursor>`. Errors are one stderr line plus a `hint:` line (parse errors too, with no usage block). Empty results print a note on stderr, with the retention caveat when the window starts past it, and exit 0.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | runtime/provider error, or an unexpected bug (`error:` plus a hint that it is a bug in traces; `TRACES_DEBUG=1` adds the stack) |
| 2 | usage/config error |
| 3 | auth error |

## Limits

- `logs --limit`: default 100, max 1000 per page.
- `deploys --limit`: default 10, max 100 per page.
- `errors` has no `--limit`: it reads at most 2000 error logs per service, and fetches at most 200 error traces per service.

## Retention

Railway keeps logs 3d (Free), 7d (Hobby), 30d (Pro). Vercel runtime logs: 1h (Hobby), 1d (Pro), 30d (Observability Plus). An empty result older than that is not "no errors". The same goes for the `errors --since deploy` baseline: when it reaches past the shortest retention, stderr warns that groups may be wrongly marked `new`.
