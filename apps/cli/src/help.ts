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
  FOLLOW_INTERVAL_SECONDS,
  LOGS_LIMIT,
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
      'Show the project matched for the current directory, its services, and whether each provider is authenticated.',
    arguments: [],
    flags: [],
    output:
      'one record per service: configPath, project, matchedBy (flag | path | git), service, provider, ref (the config entry), auth {status: ok | missing | invalid, detail}.',
    notes: [
      'Run this first when another command says no project matches or auth fails.',
      'Auth check: Railway runs `railway whoami`; Vercel validates the token against the API.',
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
        description: `30m | 1h | 2d | ISO timestamp (default ${DEFAULT_WINDOW}; with --build, no lower bound)`,
      },
      {
        name: 'until',
        usage: '--until <when>',
        description: 'window end, same formats (default now)',
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
      'LogRecord per line: ts, service, provider, environment, deploymentId?, source (runtime | build | http), level (debug | info | warn | error | fatal | unknown), message, request? {method, path, status, durationMs?, requestId?}, traceId?, spanId?, attrs. Compact text on a TTY.',
    notes: [
      MORE_NOTE,
      EMPTY_NOTE,
      '--build and --http are mutually exclusive; --follow works with runtime and --http, not with --build or --cursor.',
      "Vercel: runtime records are the app's own log lines. A 5xx with no log line only shows up with --http; use `--http --level error` (on --http, level comes from the status: 5xx error, 4xx warn).",
      'Vercel build logs: stderr lines are level error (tool warnings included); fatal events are fatal.',
      'Railway has no fatal level, so --level fatal alone matches nothing there.',
      '--cursor continues the original window; repeat the original flags exactly as the `more:` line prints them.',
      '--grep is a literal substring match on the message only: it is not a regex and does not search attrs. Matching is case-insensitive on Railway and Vercel.',
      '`ts` is the provider receive time. A timestamp the app emitted itself, when present, is in `attrs.timestamp`.',
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
    tagline: 'error/fatal logs grouped by fingerprint, most frequent first',
    synopsis: 'traces errors [service] [flags]',
    summary:
      'Group error and fatal logs by fingerprint, most frequent first. Start here for "what is failing".',
    arguments: [ERRORS_SERVICE_ARGUMENT],
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
    ],
    output:
      'one group per line: fingerprint, service, count, firstSeen, lastSeen, deploymentIds, sample (full message of the first occurrence), traceId (optional; from the first record that has one), provider, environment, hint, partial. `hint` is a ready-to-run `traces logs ... --grep` command for that group.',
    notes: [
      'Without a service, every service of the project is covered (fetched concurrently); each group keeps its `service` and all groups are sorted by count.',
      'If one service fails (auth, provider error) while the others succeed, the successful groups are still printed, stderr gets `error: <service>: ...` per failed service, and the exit code is 1.',
      'Messages are grouped by their first line with ids, hex, quoted strings and numbers collapsed.',
      `At most ${ERROR_CAP} error logs are read. When the cap is hit, counts are partial (newest ${ERROR_CAP} only): every group of that service has \`partial: true\` and stderr says so (the cap is per service). Narrow --since for exact counts.`,
      EMPTY_NOTE,
      'Vercel: only logged errors are counted; 5xx responses without a log line are not (see `traces logs --http`).',
    ],
    examples: [
      'traces errors api --since 1h',
      'traces errors api --since 2d --json',
    ],
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
    ...section('GLOBAL FLAGS', renderFlags(GLOBAL_FLAGS)),
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
    '',
    'COMMANDS  (details and examples: traces <command> --help)',
    ...indent(commandSummaries()),
    '',
    '  global flags: ' + GLOBAL_FLAGS.map((flag) => flag.usage).join('  '),
    '',
    'RECIPES',
    '  what is failing anywhere  traces errors --since 1d   (all services, one list)',
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
    `  errors has no --limit: it reads at most ${ERROR_CAP} error logs per service.`,
    '',
    'OUTPUT',
    '  stdout: compact lines on a TTY; NDJSON when piped or with --json (one record per',
    '  line: LogRecord, Deployment, or error group; fields are stable). When older records',
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
