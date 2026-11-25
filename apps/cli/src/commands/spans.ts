import {
  attributePage,
  decodeCursor,
  type ErrorTraceScan,
  encodeCursor,
  fromTraceCursor,
  type PageResume,
  pageTraces,
  scanErrorTraces,
  scanTraceWindow,
  toTraceCursor,
  toTraceRow,
  traceFetchSize,
} from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { UsageError } from '#/errors.ts';
import {
  DEFAULT_WINDOW,
  SPANS_LIMIT,
  TRACE_SCAN_CAP,
  TRACE_SCAN_PAGE,
} from '#/limits.ts';
import {
  commandLine,
  emitRecord,
  emptyNotice,
  formatTraceLine,
  outputMode,
  windowSpansDays,
} from '#/output.ts';
import { globalOptions, resolveTraceService } from '#/resolve.ts';
import { parseDuration, parseInstant } from '#/time.ts';

const parseAttributes = (pairs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const attributes: Record<string, string> = {};
    for (const pair of pairs) {
      const separator = pair.indexOf('=');
      if (separator < 1) {
        return yield* new UsageError({
          message: `cannot parse --attr "${pair}"`,
          hint: 'use --attr key=value, repeated for more than one',
        });
      }
      const key = pair.slice(0, separator);
      if (key in attributes) {
        return yield* new UsageError({
          message: `--attr "${key}" is given twice`,
          hint: 'Jaeger matches each attribute key once; pass it a single time',
        });
      }
      attributes[key] = pair.slice(separator + 1);
    }
    return attributes;
  });

const optionalDuration = (flag: string, value: Option.Option<string>) =>
  Option.isSome(value)
    ? parseDuration(flag, value.value).pipe(Effect.map(Option.some))
    : Effect.succeed(Option.none());

export const spansOptions = {
  ...globalOptions,
  service: Argument.String('service').pipe(
    Argument.withDescription(
      'service name from the config; optional when the project has exactly one',
    ),
    Argument.optional,
  ),
  since: Flag.String('since').pipe(
    Flag.withDescription(
      `30m | 1h | 2d | ISO timestamp (default ${DEFAULT_WINDOW})`,
    ),
    Flag.optional,
  ),
  until: Flag.String('until').pipe(
    Flag.withDescription('window end, same formats (default now)'),
    Flag.optional,
  ),
  op: Flag.String('op').pipe(
    Flag.withDescription('only traces with this operation name (exact match)'),
    Flag.optional,
  ),
  'min-duration': Flag.String('min-duration').pipe(
    Flag.withDescription(
      'only traces at least this long: 500ms | 1s | 1.5s | 2m | 1h',
    ),
    Flag.optional,
  ),
  'max-duration': Flag.String('max-duration').pipe(
    Flag.withDescription('only traces at most this long, same formats'),
    Flag.optional,
  ),
  errors: Flag.Boolean('errors').pipe(
    Flag.withDescription('only traces with at least one error span'),
    Flag.withDefault(false),
  ),
  attr: Flag.String('attr').pipe(
    Flag.withDescription(
      'only traces with a span attribute equal to the value (k=v); repeat for several. Without /api/traces on tracing.url it reads whole traces through /api/v3 and matches on the client (slower)',
    ),
    Flag.atLeast(0),
  ),
  limit: Flag.Int('limit').pipe(
    Flag.withDescription(
      `traces per page, 1-${SPANS_LIMIT.max} (default ${SPANS_LIMIT.default})`,
    ),
    Flag.withDefault(SPANS_LIMIT.default),
  ),
  cursor: Flag.String('cursor').pipe(
    Flag.withDescription('continue backwards from a `more:` line'),
    Flag.optional,
  ),
};

export const spansCommand = Command.make('spans', spansOptions, (args) =>
  Effect.gen(function* () {
    if (args.limit < 1 || args.limit > SPANS_LIMIT.max) {
      return yield* new UsageError({
        message: `--limit must be between 1 and ${SPANS_LIMIT.max}`,
        hint: 'page further back with --cursor instead',
      });
    }
    const now = new Date();
    const minDuration = yield* optionalDuration(
      '--min-duration',
      args['min-duration'],
    );
    const maxDuration = yield* optionalDuration(
      '--max-duration',
      args['max-duration'],
    );
    if (
      Option.isSome(minDuration) &&
      Option.isSome(maxDuration) &&
      minDuration.value.ms > maxDuration.value.ms
    ) {
      return yield* new UsageError({
        message: '--min-duration is longer than --max-duration',
        hint: 'swap them, or drop one',
      });
    }
    const attributes = yield* parseAttributes(args.attr);
    const resumed = Option.isSome(args.cursor)
      ? yield* decodeCursor(args.cursor.value).pipe(
          Effect.flatMap(fromTraceCursor),
        )
      : undefined;
    // The cursor carries the window start so a relative `--since 1h` cannot drift between pages.
    const since =
      resumed?.since ??
      (yield* parseInstant(
        '--since',
        Option.getOrElse(args.since, () => DEFAULT_WINDOW),
        now,
      ));
    const until = Option.isSome(args.until)
      ? yield* parseInstant('--until', args.until.value, now)
      : undefined;
    if (since.getTime() >= (until ?? now).getTime()) {
      return yield* new UsageError({
        message: '--since is not before --until',
        hint: 'the window must have a start earlier than its end',
      });
    }

    const service = yield* resolveTraceService(args, args.service);
    const windowEnd = (until ?? now).toISOString();
    const query = {
      service: service.otelService,
      operation: Option.getOrUndefined(args.op),
      startTimeMin: since.toISOString(),
      startTimeMax: windowEnd,
      minDuration: Option.getOrUndefined(
        Option.map(minDuration, (parsed) => parsed.text),
      ),
      maxDuration: Option.getOrUndefined(
        Option.map(maxDuration, (parsed) => parsed.text),
      ),
    };
    const matchesAttributes = Object.keys(attributes).length > 0;
    const fetchPage = matchesAttributes
      ? attributePage({
          backend: service.backend,
          query,
          attributes,
          windowEnd,
          requireError: args.errors,
        })
      : (request: {
          readonly resume?: PageResume;
          readonly size: number;
          readonly serverFiltered: boolean;
        }) =>
          service.backend
            .searchTraces({
              ...query,
              startTimeMax: request.resume?.before ?? windowEnd,
              errorsOnly: request.serverFiltered,
              limit: traceFetchSize(request.size, request.resume),
            })
            .pipe(
              Effect.map((summaries) =>
                pageTraces({
                  summaries,
                  limit: request.size,
                  resume: request.resume,
                }),
              ),
            );
    const scanInput = {
      limit: args.limit,
      scanCap: TRACE_SCAN_CAP,
      pageSize: TRACE_SCAN_PAGE,
      resume: resumed?.resume,
      mode: resumed?.mode,
      fetchPage,
    };
    const fromScan = (scan: ErrorTraceScan) => ({
      traces: scan.matches,
      next: scan.next,
      mode: args.errors ? scan.mode : undefined,
      capped: scan.capped,
      scanned: scan.scanned,
    });

    const result = args.errors
      ? yield* scanErrorTraces(scanInput).pipe(Effect.map(fromScan))
      : matchesAttributes
        ? yield* scanTraceWindow(scanInput, 'client').pipe(Effect.map(fromScan))
        : yield* fetchPage({
            resume: resumed?.resume,
            size: args.limit,
            serverFiltered: false,
          }).pipe(
            Effect.map((page) => ({
              traces: page.kept,
              next: page.next,
              mode: undefined,
              capped: false,
              scanned: page.kept.length,
            })),
          );

    const mode = outputMode(args.json);
    const withDate = windowSpansDays(since, until ?? now);
    for (const summary of result.traces) {
      yield* emitRecord(mode, toTraceRow(summary), (row) =>
        formatTraceLine(row, withDate),
      );
    }
    const searched = `${args.errors ? 'error traces' : 'traces'}${matchesAttributes ? ' matching --attr' : ''}`;
    if (result.traces.length === 0) {
      // An empty page with a cursor is a capped scan, not an empty window.
      const window =
        result.next === undefined
          ? `in ${since.toISOString()} to ${windowEnd}`
          : `in the scanned range (${result.next.before} to ${resumed?.resume.before ?? windowEnd}); more below`;
      yield* emptyNotice(
        searched,
        `for ${service.otelService} (jaeger) ${window}`,
      );
    }
    if (result.capped) {
      yield* Console.error(
        `note: scanned ${result.scanned} traces (cap ${TRACE_SCAN_CAP}) and found ${result.traces.length} of ${args.limit} ${searched}; older traces were not read. Run the \`more:\` command to keep scanning.`,
      );
    }
    if (result.next !== undefined) {
      yield* Console.error(
        `more: ${commandLine(
          'spans',
          [service.name],
          [
            ['project', Option.getOrUndefined(args.project)],
            ['env', Option.getOrUndefined(args.env)],
            ['config', Option.getOrUndefined(args.config)],
            ['json', args.json],
            ['since', Option.getOrUndefined(args.since)],
            ['until', Option.getOrUndefined(args.until)],
            ['op', Option.getOrUndefined(args.op)],
            ['min-duration', Option.getOrUndefined(args['min-duration'])],
            ['max-duration', Option.getOrUndefined(args['max-duration'])],
            ['errors', args.errors],
            ...args.attr.map((pair) => ['attr', pair] as const),
            ['limit', String(args.limit)],
            [
              'cursor',
              encodeCursor(toTraceCursor(since, result.next, result.mode)),
            ],
          ],
        )}`,
      );
    }
  }),
).pipe(
  Command.withShortDescription(
    'search traces of a service in Jaeger, oldest to newest',
  ),
  Command.withDescription(
    `List traces that touch a service's otelService, one summary per trace. Default: the last ${DEFAULT_WINDOW}. Needs a \`tracing\` block in the project config.`,
  ),
  Command.withExamples([
    {
      command: 'traces spans web --min-duration 1s',
      description: 'slow requests',
    },
    { command: 'traces spans web --errors --since 1d' },
    {
      command: 'traces spans web --op "GET /api/x" --attr http.status_code=500',
    },
  ]),
);
