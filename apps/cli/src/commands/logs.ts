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
import { deployInstant, deploySinceText } from '#/deploy-window.ts';
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
  emitRecord,
  emptyNotice,
  formatLogLine,
  type OutputMode,
  outputMode,
  retentionNoteFor,
  windowSpansDays,
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';
import { parseInstant, parseWhen } from '#/time.ts';

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

const recordKey = (record: LogRecord) =>
  `${record.ts}\0${record.deploymentId ?? ''}\0${record.message}`;

const follow = (input: {
  readonly source: LogSource;
  readonly kind: 'http' | 'runtime';
  readonly query: LogQuery;
  readonly mode: OutputMode;
  readonly withDate: boolean;
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
      yield* emitRecord(input.mode, record, (r) =>
        formatLogLine(r, input.withDate),
      );
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
  service: Argument.String('service').pipe(Argument.optional),
  since: Flag.String('since').pipe(Flag.optional),
  until: Flag.String('until').pipe(Flag.optional),
  level: Flag.String('level').pipe(Flag.optional),
  grep: Flag.String('grep').pipe(Flag.optional),
  deploy: Flag.String('deploy').pipe(Flag.optional),
  build: Flag.Boolean('build').pipe(Flag.withDefault(false)),
  http: Flag.Boolean('http').pipe(Flag.withDefault(false)),
  limit: Flag.Int('limit').pipe(Flag.withDefault(LOGS_LIMIT.default)),
  cursor: Flag.String('cursor').pipe(Flag.optional),
  follow: Flag.Boolean('follow').pipe(
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
      yield* Console.error(deploySinceText(deployment, since));
    } else {
      since = when?.at;
    }
    const query: LogQuery = {
      since,
      until,
      levels,
      grep: Option.getOrUndefined(args.grep),
      deploymentId:
        Option.getOrUndefined(args.deploy) ??
        (kind === 'build' ? 'latest' : undefined),
      limit: args.limit,
      cursor,
    };
    const mode = outputMode(args.json);
    const page = yield* fetchPage(resolved.source, kind, query);
    const windowStart =
      since ??
      (page.records[0] === undefined
        ? undefined
        : new Date(page.records[0].ts));
    const withDate =
      windowStart !== undefined && windowSpansDays(windowStart, until ?? now);
    for (const record of page.records) {
      yield* emitRecord(mode, record, (r) => formatLogLine(r, withDate));
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
            ['deploy', Option.getOrUndefined(args.deploy)],
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
        mode,
        withDate,
        initial: page.records,
      });
    }
  }),
);
