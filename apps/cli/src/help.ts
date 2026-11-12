/**
 * All user-facing help lives here, hand-written, so it is plain text with no
 * framework boilerplate. Each command's flags are documented once, in
 * `COMMAND_HELP`; the top-level help and the per-command help are both
 * rendered from it, and `test/help.test.ts` fails when a flag is defined in a
 * command but missing here (or the reverse).
 */

import {
  DEFAULT_WINDOW,
  DEPLOYS_LIMIT,
  ERROR_CAP,
  ERROR_TRACE_CAP,
  FOLLOW_INTERVAL_SECONDS,
  LOGS_LIMIT,
  SPANS_LIMIT,
  TRACE_SCAN_CAP,
} from '#/limits.ts';

export interface FlagHelp {
  /** Long flag name without dashes; must match the option key in the command. */
  readonly name: string;
  /** How the flag reads in help, e.g. `-f, --follow` or `--since <when>`. */
  readonly usage: string;
  readonly description: string;
}

export interface CommandHelp {
  readonly synopsis: string;
  /** One line for the top-level command list. */
  readonly tagline: string;
  readonly summary: string;
  /** Positional arguments, as `[name, description]`. */
  readonly arguments: ReadonlyArray<readonly [string, string]>;
  readonly flags: ReadonlyArray<FlagHelp>;
  /** One paragraph describing the records on stdout. */
  readonly output: string;
  /** One bullet per entry; the renderer wraps them. */
  readonly notes: ReadonlyArray<string>;
  readonly examples: ReadonlyArray<string>;
  /** The command takes none of the global flags, so help leaves out that section. */
  readonly noGlobalFlags?: true;
}

export const GLOBAL_FLAGS: ReadonlyArray<FlagHelp> = [
  {
    name: 'project',
    usage: '--project <name>',
    description: 'project from the config; overrides cwd matching',
  },
  {
    name: 'env',
    usage: '--env <name>',
    description:
      'Railway environment name, or Vercel target (production | preview)',
  },
  {
    name: 'config',
    usage: '--config <path>',
    description: 'config file (default $XDG_CONFIG_HOME/traces/config.json)',
  },
  {
    name: 'json',
    usage: '--json',
    description: 'NDJSON output even on a TTY (it is the default when piped)',
  },
];

const SERVICE_ARGUMENT = [
  'service',
  'service name from the config; optional when the project has exactly one',
] as const;

const ERRORS_SERVICE_ARGUMENT = [
  'service',
  'service name from the config; omit to cover all services of the project',
] as const;

const MORE_NOTE =
  'When older records exist, stderr gets `more: <full command with --cursor>`; run it for the next page.';

const EMPTY_NOTE =
  'An empty result exits 0 and says so on stderr. When the window starts past the shortest provider retention (Railway 3d, Vercel 1h), the note adds the retention caveat: past that window, empty does not mean "no errors".';

export const COMMAND_HELP = {
  services: {
    tagline: 'matched project, services, provider auth status',
    synopsis: 'traces services [flags]',
    summary:
      'Show the project matched for the current directory, its services, whether each provider is authenticated, and the tracing setup (URL, header secrets, otelService) with a live reachability check of the tracing URL.',
    arguments: [],
    flags: [],
    output:
      'one record per service: configPath, project, matchedBy (flag | path | git), service, provider (absent for trace-only), ref (the config entry), auth {status: ok | missing | invalid, detail} (absent for trace-only), otelService (the Jaeger service name; set when the project has tracing or the entry names one), tracing (when the project has it) {provider, url, headers[], check}, check being {status: reachable, services[]} (the Jaeger service names) | {status: unauthorized} | {status: error, detail}, and otelInJaeger (boolean, only when check is reachable): whether Jaeger reports the otelService. Each tracing header is {name, source: literal | env | keychain, ref, status: present | missing | error, detail?}; literal headers carry no ref or status. Values are never printed.',
    notes: [
      'Run this first when another command says no project matches or auth fails.',
      'Auth check: Railway runs `railway whoami`; Vercel validates the token against the API.',
      'With a `tracing` block, one `/api/v3/services` request (5s timeout) checks the URL: reachable, unauthorized (credentials rejected), or error with a short reason (an HTML page, a redirect, a missing secret, no answer). A failed check still exits 0. Every service whose otelService Jaeger does not report is listed as `<service> → <otelService>: not in Jaeger`; a wrong name there is why `traces spans` comes back empty. Projects without `tracing` make no request.',
      'Tracing: `traces secret set <ref>` fixes a missing keychain secret; an env header is `missing` until that variable is exported. Reading keychain entries here may prompt macOS for access.',
    ],
    examples: ['traces services', 'traces services --project myapp --json'],
  },
  logs: {
    tagline: 'runtime logs, oldest to newest (also --build, --http)',
    synopsis: 'traces logs [service] [flags]',
    summary: `Print logs for one service, oldest to newest. Default: runtime logs of the last ${DEFAULT_WINDOW}.`,
    arguments: [SERVICE_ARGUMENT],
    flags: [
      {
        name: 'since',
        usage: '--since <when>',
        description: `30m | 1h | 2d | ISO timestamp | deploy (default ${DEFAULT_WINDOW}; with --build, no lower bound). deploy: the start time of the service's latest ready deploy; stderr says which one. none ready: exit 1`,
      },
      {
        name: 'until',
        usage: '--until <when>',
        description: 'window end, same formats except deploy (default now)',
      },
      {
        name: 'level',
        usage: '--level <levels>',
        description: 'only these, comma-separated: debug,info,warn,error,fatal',
      },
      {
        name: 'grep',
        usage: '--grep <text>',
        description:
          'only messages containing text: a literal substring of the message, not a regex; attrs are not searched',
      },
      {
        name: 'deploy',
        usage: '--deploy <id|latest>',
        description: 'one deployment instead of the whole service',
      },
      {
        name: 'build',
        usage: '--build',
        description:
          'build logs of --deploy (default latest) instead of runtime logs',
      },
      {
        name: 'http',
        usage: '--http',
        description:
          'request records (method path status duration) instead of log lines',
      },
      {
        name: 'limit',
        usage: '--limit <n>',
        description: `records per page, 1-${LOGS_LIMIT.max} (default ${LOGS_LIMIT.default})`,
      },
      {
        name: 'cursor',
        usage: '--cursor <c>',
        description: 'continue backwards from a `more:` line',
      },
      {
        name: 'follow',
        usage: '-f, --follow',
        description: `print the latest --limit records, then poll every ~${FOLLOW_INTERVAL_SECONDS}s until Ctrl-C`,
      },
    ],
    output:
      'LogRecord per line: ts, appTs?, service, provider, environment, deploymentId?, source (runtime | build | http), level (debug | info | warn | error | fatal | unknown), message, request? {method, path, status, durationMs?, requestId?}, traceId?, spanId?, attrs. Compact text on a TTY.',
    notes: [
      MORE_NOTE,
      EMPTY_NOTE,
      'A trace-only service (config entry with only `otelService`) has no logs: exit 2 with "<service> has no log provider; it\'s trace-only".',
      '--build and --http are mutually exclusive; --follow works with runtime and --http, not with --build or --cursor.',
      "Vercel: runtime records are the app's own log lines. A 5xx with no log line only shows up with --http; use `--http --level error` (on --http, level comes from the status: 5xx error, 4xx warn).",
      'Vercel build logs: stderr lines are level error (tool warnings included); fatal events are fatal.',
      'Railway has no fatal level, so --level fatal alone matches nothing there.',
      '--cursor continues the original window; repeat the original flags exactly as the `more:` line prints them.',
      '--grep is a literal substring match on the message only: it is not a regex and does not search attrs. Matching is case-insensitive on Railway and Vercel.',
      "`ts` is the provider receive (ingest) time: on Railway it runs a few seconds after the app logged the line. Paging, --since and --until use it. `appTs` (ISO, UTC) is the app's own time, set only when `attrs.timestamp` is an ISO-8601 string with a zone (a number is left in attrs); use it to line a log up against span times from `traces trace`. TTY lines show `ts`.",
      "`attrs` values are JSON-decoded once on Railway: Effect loggers' `annotations` and `spans` are real objects, and a value that is not valid JSON stays a string.",
      '`traceId` / `spanId` are set only when the record carries a 32-hex trace id (16-hex span id): Vercel from the request row, Railway from `attrs.annotations.traceId` or a top-level `traceId` / `trace_id` attr. A TTY shows `trace=<first 8>`.',
      'On a TTY, times are UTC with a Z suffix, and the date is prefixed when the window spans more than one day. JSON `ts` is always the full ISO timestamp.',
      '-f prints `following <service> ...` once on stderr; stdout stays NDJSON.',
    ],
    examples: [
      'traces logs api --since 30m --level error',
      'traces logs api --grep timeout --limit 500',
      'traces logs api --http --level error        # 5xx requests',
      'traces logs web --build                     # build logs of the latest deployment',
      'traces logs api --deploy <id> --level error # one deployment',
      'traces logs api --since 2026-10-12T14:00:00Z --until 2026-10-12T14:10:00Z',
      'traces logs api -f                          # watch while reproducing',
    ],
  },
  deploys: {
    tagline: 'deployments: status, commit sha, branch, time, url',
    synopsis: 'traces deploys [service] [flags]',
    summary:
      'List deployments of a service, newest first: status, commit, branch, time, url.',
    arguments: [SERVICE_ARGUMENT],
    flags: [
      {
        name: 'limit',
        usage: '--limit <n>',
        description: `deployments per page, 1-${DEPLOYS_LIMIT.max} (default ${DEPLOYS_LIMIT.default})`,
      },
      {
        name: 'cursor',
        usage: '--cursor <c>',
        description: 'continue from a `more:` line',
      },
    ],
    output:
      'Deployment per line: id, service, provider, environment, status (queued | building | deploying | ready | failed | canceled | crashed | removed | sleeping | unknown), rawStatus, createdAt, url?, commit? {sha, message?, branch?}.',
    notes: [
      MORE_NOTE,
      'A trace-only service (config entry with only `otelService`) has no deployments: exit 2.',
      '`commit` is absent when the provider did not record one, e.g. Railway deploys made from the CLI or from an image.',
      "Did a fix deploy? Compare the newest `ready` deployment's sha with `git rev-parse HEAD`. Without a commit, compare its `createdAt` with the time of the push.",
      "Vercel lists the deployments of --env (default production); Railway lists the service's environment.",
    ],
    examples: [
      'traces deploys api',
      'traces deploys web --env preview --limit 3 --json',
    ],
  },
  errors: {
    tagline:
      'error logs and error spans grouped by fingerprint, most frequent first',
    synopsis: 'traces errors [service] [flags]',
    summary:
      'Group error and fatal logs, plus error spans from Jaeger when the project has `tracing`, by fingerprint, most frequent first. Start here for "what is failing".',
    arguments: [ERRORS_SERVICE_ARGUMENT],
    flags: [
      {
        name: 'since',
        usage: '--since <when>',
        description: `30m | 1h | 2d | ISO timestamp | deploy (default ${DEFAULT_WINDOW}). deploy: each service's window starts at its own latest ready deploy; see --since deploy below`,
      },
      {
        name: 'until',
        usage: '--until <when>',
        description: 'window end, same formats except deploy (default now)',
      },
      {
        name: 'source',
        usage: '--source <logs|traces>',
        description:
          'only log groups, or only trace groups (default: both; the trace side runs only when the project has `tracing`)',
      },
    ],
    output:
      'one group per line: source (logs | traces), fingerprint, service, count (events: the lines of one multi-line error, such as a stack trace, count once), lines (log groups only: the log lines behind count, which is what grep counts), firstSeen, lastSeen, deploymentIds (always empty for trace groups), sample (full message of the first occurrence; `<exception type>: <message>` for traces), traceId (optional; the first record that carries one, or the newest sampled trace), traceIds (trace groups only: up to 3 distinct traces), provider (railway | vercel | jaeger), environment (absent for trace groups), hint, partial, and with --since deploy `new`, `deploymentId`, `deployedAt`. `hint` is a ready-to-run `traces logs ... --grep` command for a log group and `traces trace <traceId>` for a trace group. On a TTY, trace groups carry a `[traces]` marker, and a log group whose lines differ from its count reads `14x (96 lines)`.',
    notes: [
      'Without a service, every service of the project is covered (fetched concurrently); each group keeps its `service` and all groups, log and trace, are sorted by count. A trace-only service (no `provider`) is skipped on the log side and taken by the trace side; naming one exits 2 when the trace side will not run (no `tracing`, or --source logs).',
      "Trace groups: when the project has `tracing`, each service's `otelService` is searched in the window, the full trace of every trace with error spans is fetched, and the error spans of that service are fingerprinted like Issues do (exception type, normalized message and top in-app frame; an error span without an exception event groups by span name and status message). A log group and a trace group for the same failure stay separate; match them by the traceId.",
      `At most ${ERROR_TRACE_CAP} error traces are fetched per service, newest first, and at most ${TRACE_SCAN_CAP} traces are read to find them. When either cap leaves older traces unread, every trace group of that service has \`partial: true\` and stderr says so. Narrow --since for exact counts.`,
      'If one service fails (auth, provider error) while the others succeed, the successful groups are still printed, stderr gets `error: <service>: ...` per failed log service (`error: <service> (traces): ...` for the trace side, `error: tracing: ...` when the tracing secret or backend cannot be set up), and the exit code is 1.',
      '--since deploy: each service with a log provider starts its window at the start time of its own latest ready deploy (among the last 20), so a multi-service run has per-service windows; stderr prints `<service>: since deploy <id> at <time>; baseline <span> before`. Trace groups of such a service use the same window; trace-only services are skipped with a stderr note. With no ready deploy the service fails with exit 1 (`traces deploys <service>` shows why).',
      'Baseline (--since deploy only): each service also reads its errors in the window before the deploy, as long as the post-deploy window (until --until or now), at most 24h. Every group then carries `new: true` when no baseline error in that service has its fingerprint, `deploymentId` and `deployedAt` (the window start). Baseline errors are used only for fingerprints, never counted. If the baseline hit a cap, stderr says `new` may over-report. Hints keep `--since deploy`, so they stay copy-pasteable.',
      'Messages are grouped by their first line with ids, hex, quoted strings and numbers collapsed.',
      `At most ${ERROR_CAP} error logs are read. When the cap is hit, counts are partial (newest ${ERROR_CAP} only): every group of that service has \`partial: true\` and stderr says so (the cap is per service). Narrow --since for exact counts.`,
      EMPTY_NOTE,
      'Vercel: only logged errors are counted; 5xx responses without a log line are not (see `traces logs --http`).',
    ],
    examples: [
      'traces errors api --since 1h',
      'traces errors api --since 2d --json',
      'traces errors --since deploy     # then read the groups with new: true',
      'traces errors --since 1d --source traces     # error spans only',
      "traces errors --source traces --json | jq -r '.hint'   # trace commands to run",
    ],
  },
  spans: {
    tagline: 'search traces of a service in Jaeger, oldest to newest',
    synopsis: 'traces spans [service] [flags]',
    summary: `List traces that touch a service's otelService, one summary per trace. Default: the last ${DEFAULT_WINDOW}. Needs a \`tracing\` block in the config (see TRACING in \`traces --help\`).`,
    arguments: [SERVICE_ARGUMENT],
    flags: [
      {
        name: 'since',
        usage: '--since <when>',
        description: `30m | 1h | 2d | ISO timestamp (default ${DEFAULT_WINDOW})`,
      },
      {
        name: 'until',
        usage: '--until <when>',
        description: 'window end, same formats (default now)',
      },
      {
        name: 'op',
        usage: '--op <name>',
        description: 'only traces with this operation name (exact match)',
      },
      {
        name: 'min-duration',
        usage: '--min-duration <dur>',
        description:
          'only traces at least this long: 500ms | 1s | 1.5s | 2m | 1h',
      },
      {
        name: 'max-duration',
        usage: '--max-duration <dur>',
        description: 'only traces at most this long, same formats',
      },
      {
        name: 'errors',
        usage: '--errors',
        description: 'only traces with at least one error span',
      },
      {
        name: 'attr',
        usage: '--attr <k=v>',
        description:
          'only traces with a span attribute equal to the value; repeat for several',
      },
      {
        name: 'limit',
        usage: '--limit <n>',
        description: `traces per page, 1-${SPANS_LIMIT.max} (default ${SPANS_LIMIT.default})`,
      },
      {
        name: 'cursor',
        usage: '--cursor <c>',
        description: 'continue backwards from a `more:` line',
      },
    ],
    output:
      'TraceRow per line: traceId, rootService, rootOperation, startTs (ISO, nanosecond precision), durationMs, spanCount, errorSpanCount (0 when the backend reports none), services[]. On a TTY: `02:55:09.123Z 412ms ERR×2 mockingbird-web GET /api/x  a042d0ba…` (ERR×n only when the trace has error spans; the last column is the first 8 of the traceId).',
    notes: [
      MORE_NOTE,
      "Searches the service's `otelService` (default: the service key); a trace-only service works. Traces are summarised whole: `services` lists every service in the trace, not just the one searched.",
      'Pages go backwards: each page is the newest traces left in the window, printed oldest to newest. The `more:` cursor carries the window start, so a relative --since cannot drift; repeat the other flags exactly as the line prints them.',
      `--errors asks Jaeger for error-tagged traces and checks each one's errorSpanCount > 0; when Jaeger returns nothing, or has no /api/traces, it pages the unfiltered window and counts on the client. It reads pages until --limit error traces are found, the window ends, or ${TRACE_SCAN_CAP} traces were read; at the cap stderr says so and \`more:\` continues the scan.`,
      "--attr is searched through Jaeger's legacy `/api/traces`, because the v3 API ignores attribute filters. If tracing.url does not serve it (404 or 405), the CLI reads the window through /api/v3/traces and keeps the traces where some span or its resource has the attribute with exactly that string value; that reads whole traces, so it is slower and stops at 1000 traces read, returning the matches found so far.",
      'An empty result exits 0 and says so on stderr. An empty result for a service Jaeger has never seen usually means a wrong otelService: `traces services` shows the name searched.',
      'Jaeger keeps traces only as long as its storage backend does (in-memory Jaeger drops them on restart): an empty old window is not proof of no traffic.',
      'On a TTY, times are UTC with a Z suffix, and the date is prefixed when the window spans more than one day. JSON `startTs` is always the full ISO timestamp.',
    ],
    examples: [
      'traces spans web --since 3d',
      'traces spans web --min-duration 1s           # slow requests',
      'traces spans web --errors --since 1d',
      'traces spans web --op "GET /api/x" --attr http.status_code=500',
      'traces spans web --limit 50 --json',
    ],
  },
  trace: {
    tagline: 'show one trace as a span tree from Jaeger',
    synopsis: 'traces trace <traceId> [flags]',
    summary:
      'Fetch every span of one trace, ordered depth first. No service is needed; the project is still resolved for its `tracing` block (see TRACING in `traces --help`).',
    arguments: [
      [
        'traceId',
        'full 32-hex trace id (16-hex legacy ids work); the traceId of a `traces logs --json` record',
      ],
    ],
    flags: [],
    output:
      'SpanRow per line, depth first with children by start time: traceId, spanId, parentSpanId (absent on roots), depth, service, name, kind (server | client | producer | consumer | internal | unspecified), startTs (ISO, nanosecond precision), durationMs, status (ok | error | unset), statusMessage (optional), attrs (span attributes as an object), events[] ({name, ts, attrs}), exception ({type, message, stacktrace?}, optional; moved out of the first exception event, so events does not repeat the stacktrace; later exception events stay in events). On a TTY: an indented tree, `+offset duration service name`, offset from the earliest span; error spans add ERR, then the exception type and message and its top 3 stack frames.',
    notes: [
      'A span whose parent is not in the trace (partly retained or still arriving) is a root at depth 0 and keeps its parentSpanId.',
      'Span durations are whole milliseconds: spans under 1ms show 0ms.',
      'A trace Jaeger does not have exits 1 with a hint. Jaeger keeps traces only as long as its storage backend does (in-memory Jaeger drops them on restart), so an old id may have expired.',
      'A string that is not a trace id exits 2 before any request; the 8-char `trace=` prefix on a log line is too short, use `traces logs <service> --json` for the full id.',
    ],
    examples: [
      'traces trace a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e',
      'traces trace a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e --json | jq \'select(.status == "error")\'',
    ],
  },
  secret: {
    tagline: 'store or remove a keychain secret for tracing headers',
    synopsis: 'traces secret set|delete <name>',
    summary:
      'Manage the OS-keychain secrets that tracing headers refer to as {"keychain": "<name>"}. Values are stored under the keychain service `traces` and are never printed or logged.',
    arguments: [
      ['name', 'the secret name used in the config, e.g. mockingbird.jaeger'],
    ],
    flags: [],
    output: 'no records on stdout. stderr confirms what was stored or deleted.',
    notes: [
      '`set` reads the value from a hidden prompt on a terminal, or from stdin when piped (one trailing newline is dropped). An empty value is refused.',
      'Agents cannot answer the hidden prompt: the user runs `traces secret set <name>` once; after that every trace command reads the secret itself.',
      '`delete` of a name that does not exist exits 0 and says so on stderr.',
      'There is no `list`: the keychain cannot be enumerated. `traces services` shows present or missing for every secret the config references.',
      'A trace command with a missing secret exits 3 and prints the `traces secret set <name>` to run.',
      'Takes no global flags.',
    ],
    examples: [
      'traces secret set mockingbird.jaeger',
      'pbpaste | traces secret set mockingbird.jaeger',
      'traces secret delete mockingbird.jaeger',
    ],
    noGlobalFlags: true,
  },
} as const satisfies Record<string, CommandHelp>;

export type CommandName = keyof typeof COMMAND_HELP;

export const COMMAND_NAMES = Object.keys(
  COMMAND_HELP,
) as ReadonlyArray<CommandName>;

export const isCommandName = (value: string): value is CommandName =>
  value in COMMAND_HELP;

const WIDTH = 96;

const indent = (lines: ReadonlyArray<string>, by = 2) =>
  lines.map((line) => (line === '' ? line : `${' '.repeat(by)}${line}`));

/** Greedy word wrap; continuation lines start with `hanging`. */
const wrapText = (text: string, first: string, hanging: string) => {
  const lines: Array<string> = [];
  let current = first;
  let empty = true;
  for (const word of text.split(' ')) {
    if (!empty && current.length + 1 + word.length > WIDTH) {
      lines.push(current);
      current = hanging + word;
    } else {
      current = empty ? current + word : `${current} ${word}`;
    }
    empty = false;
  }
  lines.push(current);
  return lines;
};

const wrapFlags = (words: ReadonlyArray<string>, prefix: string) => {
  const lines: Array<string> = [];
  let current = prefix;
  for (const word of words) {
    const candidate =
      current === prefix ? `${prefix}${word}` : `${current}  ${word}`;
    if (candidate.length > WIDTH && current !== prefix) {
      lines.push(current);
      current = `${prefix}${word}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
};

const renderFlags = (flags: ReadonlyArray<FlagHelp>) => {
  const width = Math.max(...flags.map((flag) => flag.usage.length));
  return flags.flatMap((flag) =>
    wrapText(
      flag.description,
      `${flag.usage.padEnd(width)}  `,
      ' '.repeat(width + 2),
    ),
  );
};

const section = (title: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [title, ...indent(lines), ''];

export const renderCommandHelp = (name: CommandName): string => {
  const help: CommandHelp = COMMAND_HELP[name];
  const argumentWidth = Math.max(
    0,
    ...help.arguments.map((entry) => entry[0].length),
  );
  return [
    help.synopsis,
    '',
    ...wrapText(help.summary, '', ''),
    '',
    ...section(
      'ARGUMENTS',
      help.arguments.map(
        (entry) => `${entry[0].padEnd(argumentWidth)}  ${entry[1]}`,
      ),
    ),
    ...section('FLAGS', renderFlags(help.flags)),
    ...(help.noGlobalFlags === true
      ? []
      : section('GLOBAL FLAGS', renderFlags(GLOBAL_FLAGS))),
    ...section('OUTPUT', [
      ...wrapText(
        `stdout is NDJSON when piped or with --json. ${help.output}`,
        '',
        '',
      ),
    ]),
    ...section(
      'NOTES',
      help.notes.flatMap((note) => wrapText(note, '- ', '  ')),
    ),
    ...section('EXAMPLES', help.examples),
  ]
    .join('\n')
    .trimEnd();
};

const commandSummaries = () =>
  COMMAND_NAMES.flatMap((name) => {
    const help: CommandHelp = COMMAND_HELP[name];
    const flagLine = wrapFlags(
      help.flags.map((flag) => flag.usage),
      '    ',
    );
    return [
      `${help.synopsis.replace(' [flags]', '').padEnd(34)}${help.tagline}`,
      ...(help.flags.length === 0 ? [] : flagLine),
    ];
  });

const TOP_LEVEL = (): string =>
  [
    'traces - read logs and deployments from Vercel and Railway through one CLI.',
    '',
    'RESOLUTION',
    "  The project is matched from the cwd's git remote (or path) against the config;",
    '  --project <name> overrides. The service is the positional argument, and may be',
    '  omitted when the project has exactly one (`traces errors` without one covers all',
    '  services). Global flags may come before the command. Run `traces services` to see',
    '  what matched and whether each provider is authenticated.',
    '',
    'CONFIG  ~/.config/traces/config.json  ($XDG_CONFIG_HOME/traces/config.json, or --config <path>)',
    '  {',
    '    "projects": {',
    '      "myapp": {',
    '        "matcher": { "type": "git", "repo": "owner/repo" },',
    '        "services": {',
    '          "web": { "provider": "vercel", "project": "myapp-web", "team": "my-team" },',
    '          "api": { "provider": "railway", "project": "<railway project id>",',
    '                   "service": "api", "environment": "production" }',
    '        }',
    '      }',
    '    }',
    '  }',
    '  matcher: {"type":"git","repo":"owner/repo"} or {"type":"path","path":"~/code/myapp"}',
    '  (path wins over git; longest path wins). Vercel "team" is optional (slug or id).',
    '  Railway "service" and "environment" accept a name or an id; "environment" defaults to',
    '  production. Auth: `railway login`; Vercel uses VERCEL_TOKEN or the token the',
    '  `vercel login` CLI stored.',
    '  "otelService" (optional, any service entry) is the Jaeger service name; it defaults to the',
    '  service key. An entry with only {"otelService": "x-data"} is trace-only: logs, deploys and',
    '  the log side of errors skip it (naming one there exits 2); the trace side of errors takes it.',
    '',
    'TRACING  (per project, optional; trace commands exit 2 without it)',
    '  "tracing": { "provider": "jaeger", "url": "https://host/optional/base/path",',
    '               "headers": { "X-API-Key": { "keychain": "myapp.jaeger" } } }',
    '  url: the Jaeger query base URL as exposed to you: a subdomain or proxied path that serves',
    '  /api/v3 and /api/traces (a reverse-proxy path prefix is kept). `traces services` verifies',
    '  the URL with one request.',
    '  Header values: a literal string, {"env": "NAME"} or {"keychain": "<name>"}. Secrets are',
    '  read only when a trace command runs, never by log commands.',
    '  One-time setup, run by the user (agents cannot answer the hidden prompt):',
    '    traces secret set myapp.jaeger      (or: pbpaste | traces secret set myapp.jaeger)',
    '  `traces services` shows the URL, each referenced secret as present or missing, whether the',
    '  URL answers (reachable, unauthorized or error), and the otelService per service, flagging',
    '  any Jaeger does not report. A missing secret or env var exits 3 with the fix as a hint.',
    '',
    'COMMANDS  (details and examples: traces <command> --help)',
    ...indent(commandSummaries()),
    '',
    '  global flags: ' + GLOBAL_FLAGS.map((flag) => flag.usage).join('  '),
    '',
    'RECIPES',
    '  slow endpoint             traces spans web --min-duration 1s',
    "  failing log -> its trace  traces logs web --level error --json   (copy a record's traceId)",
    '                            traces trace <traceId>',
    '  what is failing anywhere  traces errors --since 1d   (all services, logs and error spans, one list)',
    "  error group -> its trace  traces errors --source traces --since 1d   (run a group's hint: traces trace <id>)",
    '  did my deploy add errors  traces errors --since deploy   (read the groups with new: true)',
    '                            traces logs api --since deploy --level error',
    '  why is prod 500ing        traces errors api --since 1h',
    '                            traces logs api --level error --grep "<sample from above>"',
    '                            traces logs api --http --level error     (5xx requests)',
    '  did my fix deploy         traces deploys api   (compare the sha with: git rev-parse HEAD;',
    '                            no commit shown: compare createdAt with the time of the push)',
    '  build failed              traces logs web --build',
    '  watch while reproducing   traces logs api -f',
    '  what happened at 14:05    traces logs api --since 2026-10-12T14:00:00Z --until 2026-10-12T14:10:00Z',
    '  one bad deployment        traces deploys api; traces logs api --deploy <id> --level error',
    '  older than this page      run the command from the "more:" line',
    '  preview or staging        traces logs web --env preview / traces logs api --env staging',
    '',
    'LIMITS',
    `  logs --limit: default ${LOGS_LIMIT.default}, max ${LOGS_LIMIT.max} per page.  deploys --limit: default ${DEPLOYS_LIMIT.default}, max ${DEPLOYS_LIMIT.max} per page.`,
    `  errors has no --limit: it reads at most ${ERROR_CAP} error logs per service, and fetches at most ${ERROR_TRACE_CAP} error traces per service.`,
    '',
    'OUTPUT',
    '  stdout: compact lines on a TTY; NDJSON when piped or with --json (one record per',
    '  line: LogRecord, Deployment, error group, TraceRow or SpanRow; fields are stable). When older records',
    '  exist, stderr gets "more: <full command with --cursor>". Errors are one stderr line',
    '  plus a "hint:" line (parse errors too, with no usage block). Empty results print a',
    '  note on stderr, with the retention caveat when the window starts past it, and exit 0.',
    '  Exit codes: 0 ok, 1 runtime/provider error, 2 usage/config error, 3 auth error.',
    '',
    'RETENTION',
    '  Railway keeps logs 3d (Free), 7d (Hobby), 30d (Pro). Vercel runtime logs: 1h (Hobby),',
    '  1d (Pro), 30d (Observability Plus). An empty result older than that is not "no errors".',
  ].join('\n');

export const HELP_TEXT = TOP_LEVEL();

export type HelpRequest =
  | { readonly kind: 'top' }
  | { readonly kind: 'command'; readonly name: CommandName }
  | { readonly kind: 'unknown'; readonly name: string };

const HELP_FLAGS = ['--help', '-h'];

/**
 * `traces`, `traces --help`, `traces help [cmd]`, `traces <cmd> --help` all
 * resolve here; anything else is left to the command parser.
 */
export const resolveHelpRequest = (
  args: ReadonlyArray<string>,
): HelpRequest | undefined => {
  const first = args[0];
  if (first === undefined) return { kind: 'top' };
  if (first === 'help') {
    const topic = args[1];
    if (topic === undefined) return { kind: 'top' };
    return isCommandName(topic)
      ? { kind: 'command', name: topic }
      : { kind: 'unknown', name: topic };
  }
  if (!args.some((arg) => HELP_FLAGS.includes(arg))) return undefined;
  const command = args.find(isCommandName);
  return command === undefined
    ? { kind: 'top' }
    : { kind: 'command', name: command };
};
