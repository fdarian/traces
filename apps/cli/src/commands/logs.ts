import {
  decodeCursor,
  encodeCursor,
  type LogQuery,
  type LogRecord,
  type LogSource,
  latestReadyDeployment,
  type ServiceTarget,
} from '@traces/core';
import { Console, Duration, Effect, Option, Schedule } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import {
  deployInstant,
  deploySinceText,
  postDeployLength,
} from '#/deploy-window.ts';
import { UsageError } from '#/errors.ts';
import { parseLevels } from '#/levels.ts';
import {
  DEFAULT_WINDOW,
  DEPLOY_SCAN,
  FOLLOW_INTERVAL_SECONDS,
  LOGS_LIMIT,
} from '#/limits.ts';
import {
  commandLine,
  deploymentHeader,
  emitRecord,
  emptyNotice,
  formatLogLine,
  type OutputMode,
  outputMode,
  retentionNoteFor,
  stderrIsTerminal,
  stdoutIsTerminal,
  windowSpansDays,
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';
import { parseInstant, parseWhen, requireWindow } from '#/time.ts';

const FOLLOW_INTERVAL = Duration.seconds(FOLLOW_INTERVAL_SECONDS);

const kindOf = (build: boolean, http: boolean) =>
  build ? 'build' : http ? 'http' : 'runtime';

const fetchPage = (
  source: LogSource,
  kind: 'build' | 'http' | 'runtime',
  query: LogQuery,
) =>
  kind === 'build'
    ? source.buildLogs(query)
    : kind === 'http'
      ? source.httpLogs(query)
      : source.logs(query);

/** JSON keeps an absent deployment id (`null`) apart from an empty one. */
export const recordKey = (record: LogRecord) =>
  JSON.stringify([record.ts, record.deploymentId ?? null, record.message]);

/** Text mode prints a `deploy <id>` line whenever the deployment changes; the last one printed persists across -f polls. */
const makeLogPrinter = (
  mode: OutputMode,
  withDate: boolean,
  terminal: boolean,
) => {
  let printed: string | undefined;
  return (record: LogRecord) =>
    Effect.gen(function* () {
      if (mode === 'text') {
        const header = deploymentHeader(record, printed, terminal);
        if (header !== undefined) {
          printed = record.deploymentId;
          yield* Console.log(header);
        }
      }
      yield* emitRecord(mode, record, (r) =>
        formatLogLine(r, withDate, terminal),
      );
    });
};

const follow = (input: {
  readonly source: LogSource;
  readonly kind: 'http' | 'runtime';
  readonly query: LogQuery;
  readonly print: (record: LogRecord) => Effect.Effect<void>;
  readonly initial: ReadonlyArray<LogRecord>;
}) => {
  const lastRecord = input.initial[input.initial.length - 1];
  let lastTs =
    lastRecord === undefined ? new Date().toISOString() : lastRecord.ts;
  let seenAtLastTs = new Set(
    input.initial.filter((r) => r.ts === lastTs).map(recordKey),
  );
  const poll = Effect.gen(function* () {
    const page = yield* fetchPage(input.source, input.kind, {
      ...input.query,
      since: new Date(lastTs),
      until: undefined,
      cursor: undefined,
      limit: LOGS_LIMIT.max,
    });
    const fresh = page.records.filter(
      (record) =>
        record.ts > lastTs ||
        (record.ts === lastTs && !seenAtLastTs.has(recordKey(record))),
    );
    for (const record of fresh) {
      yield* input.print(record);
    }
    const newest = fresh[fresh.length - 1];
    if (newest === undefined) return;
    if (newest.ts !== lastTs) seenAtLastTs = new Set();
    lastTs = newest.ts;
    for (const record of fresh) {
      if (record.ts === lastTs) seenAtLastTs.add(recordKey(record));
    }
  });
  return Effect.repeat(poll, Schedule.fixed(FOLLOW_INTERVAL));
};

const windowText = (query: LogQuery, target: ServiceTarget) =>
  `for ${target.service} (${target.provider}, ${target.environment}) in ${
    query.since === undefined ? 'the' : `${query.since.toISOString()} to`
  } ${query.until === undefined ? 'now' : query.until.toISOString()}`;

export const logsOptions = {
  ...globalOptions,
  service: Argument.String('service').pipe(
    Argument.withDescription(
      "service name from the config; optional when the project has exactly one. A name the config doesn't list is looked up by Railway service id or name in every Railway project the config uses; exactly one match is used (stderr names the project), none or several exit 2 with the available services",
    ),
    Argument.optional,
  ),
  since: Flag.String('since').pipe(
    Flag.withDescription(
      `30m | 1h | 2d | ISO timestamp | deploy (default ${DEFAULT_WINDOW}; with --build, no lower bound). deploy: the start time of the service's latest ready deploy; stderr says which one; none ready: exit 1`,
    ),
    Flag.optional,
  ),
  until: Flag.String('until').pipe(
    Flag.withDescription(
      'window end, same formats except deploy (default now)',
    ),
    Flag.optional,
  ),
  level: Flag.String('level').pipe(
    Flag.withDescription(
      'only these, comma-separated: debug,info,warn,error,fatal',
    ),
    Flag.optional,
  ),
  grep: Flag.String('grep').pipe(
    Flag.withDescription(
      'only messages containing text: a literal substring of the message, not a regex; attrs are not searched',
    ),
    Flag.optional,
  ),
  deploy: Flag.String('deploy').pipe(
    Flag.withDescription(
      'one deployment (id, or latest: the newest of any status, Railway skipping SKIPPED ones) instead of the whole service',
    ),
    Flag.optional,
  ),
  build: Flag.Boolean('build').pipe(
    Flag.withDescription(
      'build logs of --deploy (default latest) instead of runtime logs',
    ),
    Flag.withDefault(false),
  ),
  http: Flag.Boolean('http').pipe(
    Flag.withDescription(
      'request records (method path status duration) instead of log lines',
    ),
    Flag.withDefault(false),
  ),
  limit: Flag.Int('limit').pipe(
    Flag.withDescription(
      `records per page, 1-${LOGS_LIMIT.max} (default ${LOGS_LIMIT.default})`,
    ),
    Flag.withDefault(LOGS_LIMIT.default),
  ),
  cursor: Flag.String('cursor').pipe(
    Flag.withDescription('continue backwards from a `more:` line'),
    Flag.optional,
  ),
  follow: Flag.Boolean('follow').pipe(
    Flag.withDescription(
      `print the latest --limit records, then poll every ~${FOLLOW_INTERVAL_SECONDS}s until Ctrl-C`,
    ),

    Flag.withAlias('f'),
    Flag.withDefault(false),
  ),
};

export const logsCommand = Command.make('logs', logsOptions, (args) =>
  Effect.gen(function* () {
    if (args.limit < 1 || args.limit > LOGS_LIMIT.max) {
      return yield* new UsageError({
        message: `--limit must be between 1 and ${LOGS_LIMIT.max}`,
        hint: 'page further back with --cursor instead',
      });
    }
    if (args.build && args.http) {
      return yield* new UsageError({
        message: '--build and --http are mutually exclusive',
        hint: 'run them as separate commands',
      });
    }
    if (args.follow && (args.build || Option.isSome(args.cursor))) {
      return yield* new UsageError({
        message:
          '--follow works with runtime or --http logs, without --build or --cursor',
        hint: 'drop the conflicting flag',
      });
    }
    const kind = kindOf(args.build, args.http);
    const now = new Date();
    const when = Option.isSome(args.since)
      ? yield* parseWhen('--since', args.since.value, now)
      : kind === 'build'
        ? undefined
        : yield* parseWhen('--since', DEFAULT_WINDOW, now);
    const until = Option.isSome(args.until)
      ? yield* parseInstant('--until', args.until.value, now)
      : undefined;
    const levels = Option.isSome(args.level)
      ? yield* parseLevels(args.level.value)
      : [];
    const cursor = Option.isSome(args.cursor)
      ? yield* decodeCursor(args.cursor.value)
      : undefined;
    const resolved = yield* resolveService(args, args.service);
    let since: Date | undefined;
    if (when?._tag === 'deploy') {
      const deployment = yield* latestReadyDeployment(resolved.source, {
        service: resolved.name,
        scan: DEPLOY_SCAN,
      });
      since = yield* deployInstant(deployment);
      yield* postDeployLength(
        deployment,
        since,
        until,
        now,
        stderrIsTerminal(),
      );
      yield* Console.error(
        deploySinceText(deployment, since, stderrIsTerminal()),
      );
    } else {
      since = when?.at;
      if (since !== undefined) yield* requireWindow(since, until, now);
    }
    const requestedDeployment =
      Option.getOrUndefined(args.deploy) ??
      (kind === 'build' ? 'latest' : undefined);
    // `latest` is resolved once so the `more:` command pages the same deployment even if a newer one lands.
    const deploymentId =
      requestedDeployment === undefined
        ? undefined
        : yield* resolved.source.resolveDeploymentId(requestedDeployment);
    const query: LogQuery = {
      since,
      until,
      levels,
      grep: Option.getOrUndefined(args.grep),
      deploymentId,
      limit: args.limit,
      cursor,
    };
    const mode = outputMode(args.json);
    const terminal = stdoutIsTerminal();
    const page = yield* fetchPage(resolved.source, kind, query);
    const windowStart =
      since ??
      (page.records[0] === undefined
        ? undefined
        : new Date(page.records[0].ts));
    const withDate =
      windowStart !== undefined && windowSpansDays(windowStart, until ?? now);
    const print = makeLogPrinter(mode, withDate, terminal);
    for (const record of page.records) {
      yield* print(record);
    }
    if (page.records.length === 0) {
      yield* emptyNotice(
        kind === 'build' ? 'build logs' : kind === 'http' ? 'requests' : 'logs',
        windowText(query, resolved.target),
        retentionNoteFor(resolved.source, since, now),
      );
    }
    if (page.next !== undefined && !args.follow) {
      yield* Console.error(
        `more: ${commandLine(
          'logs',
          [resolved.name],
          [
            ['project', Option.getOrUndefined(args.project)],
            ['env', Option.getOrUndefined(args.env)],
            ['config', Option.getOrUndefined(args.config)],
            ['json', args.json],
            // The window start is settled now; re-resolving `deploy` on the next page could move it.
            [
              'since',
              when?._tag === 'deploy'
                ? since?.toISOString()
                : Option.getOrUndefined(args.since),
            ],
            ['until', Option.getOrUndefined(args.until)],
            ['level', Option.getOrUndefined(args.level)],
            ['grep', Option.getOrUndefined(args.grep)],
            ['deploy', deploymentId],
            ['build', args.build],
            ['http', args.http],
            ['limit', String(args.limit)],
            ['cursor', encodeCursor(page.next)],
          ],
        )}`,
      );
    }
    if (args.follow && kind !== 'build') {
      yield* Console.error(
        `following ${resolved.name} (poll ${FOLLOW_INTERVAL_SECONDS}s, Ctrl-C to stop)…`,
      );
      yield* follow({
        source: resolved.source,
        kind,
        query,
        print,
        initial: page.records,
      });
    }
  }),
).pipe(
  Command.withShortDescription(
    'runtime logs, oldest to newest (also --build, --http)',
  ),
  Command.withDescription(
    `Print logs for one service, oldest to newest. Default: runtime logs of the last ${DEFAULT_WINDOW}.`,
  ),
  Command.withExamples([
    { command: 'traces logs api --since 30m --level error' },
    {
      command: 'traces logs api --since deploy --level error',
      description: 'since the latest ready deploy',
    },
    {
      command: 'traces logs api --http --level error',
      description: '5xx requests',
    },
    {
      command: 'traces logs web --build',
      description: 'build logs of the latest deployment',
    },
  ]),
);
