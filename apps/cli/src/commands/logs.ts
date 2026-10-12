import { Args, Command, Options } from '@effect/cli';
import {
  decodeCursor,
  encodeCursor,
  type LogQuery,
  type LogRecord,
  type LogSource,
  type ServiceTarget,
} from '@traces/core';
import { Console, Duration, Effect, Option, Schedule } from 'effect';
import { UsageError } from '#/errors.ts';
import { parseLevels } from '#/levels.ts';
import {
  DEFAULT_WINDOW,
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
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';
import { parseWhen } from '#/time.ts';

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
      yield* emitRecord(input.mode, record, formatLogLine);
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
  service: Args.text({ name: 'service' }).pipe(Args.optional),
  since: Options.text('since').pipe(Options.optional),
  until: Options.text('until').pipe(Options.optional),
  level: Options.text('level').pipe(Options.optional),
  grep: Options.text('grep').pipe(Options.optional),
  deploy: Options.text('deploy').pipe(Options.optional),
  build: Options.boolean('build'),
  http: Options.boolean('http'),
  limit: Options.integer('limit').pipe(Options.withDefault(LOGS_LIMIT.default)),
  cursor: Options.text('cursor').pipe(Options.optional),
  follow: Options.boolean('follow').pipe(Options.withAlias('f')),
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
    const since = Option.isSome(args.since)
      ? yield* parseWhen('--since', args.since.value, now)
      : kind === 'build'
        ? undefined
        : yield* parseWhen('--since', DEFAULT_WINDOW, now);
    const until = Option.isSome(args.until)
      ? yield* parseWhen('--until', args.until.value, now)
      : undefined;
    const levels = Option.isSome(args.level)
      ? yield* parseLevels(args.level.value)
      : [];
    const cursor = Option.isSome(args.cursor)
      ? yield* decodeCursor(args.cursor.value)
      : undefined;
    const resolved = yield* resolveService(args, args.service);
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
    for (const record of page.records) {
      yield* emitRecord(mode, record, formatLogLine);
    }
    if (page.records.length === 0) {
      yield* emptyNotice(
        kind === 'build' ? 'build logs' : kind === 'http' ? 'requests' : 'logs',
        windowText(query, resolved.target),
        resolved.source.retentionNote,
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
            ['since', Option.getOrUndefined(args.since)],
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
      yield* follow({
        source: resolved.source,
        kind,
        query,
        mode,
        initial: page.records,
      });
    }
  }),
);
