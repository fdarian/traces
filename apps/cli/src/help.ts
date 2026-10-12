export const HELP_TEXT = `traces - read logs and deployments from Vercel and Railway through one CLI.

RESOLUTION
  The project is matched from the cwd's git remote (or path) against the config;
  --project <name> overrides. The service is the positional argument, and may be
  omitted when the project has exactly one. Run \`traces services\` to see what
  matched and whether each provider is authenticated.

CONFIG  ~/.config/traces/config.json  ($XDG_CONFIG_HOME/traces/config.json, or --config <path>)
  {
    "projects": {
      "myapp": {
        "matcher": { "type": "git", "repo": "owner/repo" },
        "services": {
          "web": { "provider": "vercel", "project": "myapp-web", "team": "my-team" },
          "api": { "provider": "railway", "project": "<railway project id>",
                   "service": "api", "environment": "production" }
        }
      }
    }
  }
  matcher: {"type":"git","repo":"owner/repo"} or {"type":"path","path":"~/code/myapp"}
  (path wins over git; longest path wins). Vercel "team" is optional (slug or id).
  Railway "environment" defaults to production. Auth: \`railway login\`; Vercel uses
  VERCEL_TOKEN or the token the \`vercel login\` CLI stored.

COMMANDS
  traces services                 matched project, services, provider auth status
  traces logs [service]           runtime logs, oldest to newest
      --since 1h|30m|2d|<ISO>  --until <dur|ISO>  --level error[,warn]  --grep <text>
      --deploy <id|latest>  --build (build logs)  --http (method path status duration)
      --limit 100 (max 1000)  --cursor <c>  -f/--follow (poll ~2s, Ctrl-C)
      default window: last 1h (build logs: the whole deployment). On Vercel, runtime
      logs are the app's own log lines; 5xx without a log line only show with --http.
  traces deploys [service]        deployments: status, commit sha, branch, time, url
      --limit 10  --cursor <c>
  traces errors [service]         error/fatal logs grouped by fingerprint, most frequent first
      --since 1h  --until <dur|ISO>
  global flags: --project <name>  --env <name>  --config <path>  --json
  Per-command help: traces <command> --help

RECIPES
  why is prod 500ing        traces errors api --since 1h
                            traces logs api --level error --grep "<sample from above>"
                            traces logs api --http --level error     (5xx requests)
  did my fix deploy         traces deploys api   (compare the sha with: git rev-parse HEAD)
  build failed              traces logs web --build
  watch while reproducing   traces logs api -f
  what happened at 14:05    traces logs api --since 2026-10-12T14:00:00Z --until 2026-10-12T14:10:00Z
  one bad deployment        traces deploys api; traces logs api --deploy <id> --level error
  older than this page      run the command from the "more:" line
  preview or staging        traces logs web --env preview / traces logs api --env staging

OUTPUT
  stdout: compact lines on a TTY; NDJSON when piped or with --json (one record per
  line: LogRecord, Deployment, or error group; fields are stable). When older records
  exist, stderr gets "more: <full command with --cursor>". Errors are one stderr line
  plus a "hint:" line. Empty results print a note (with the retention caveat) on
  stderr and exit 0. Exit codes: 0 ok, 1 runtime/provider error, 2 usage/config
  error, 3 auth error.

RETENTION
  Railway keeps logs 3d (Free), 7d (Hobby), 30d (Pro). Vercel runtime logs: 1h (Hobby),
  1d (Pro), 30d (Observability Plus). An empty result older than that is not "no errors".
`;
