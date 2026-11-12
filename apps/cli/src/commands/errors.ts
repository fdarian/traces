import {
  byFrequency,
  coalesceMultiline,
  type ErrorGroup,
  firstLine,
  groupErrors,
  type LogRecord,
  memoizeGetTrace,
  scanTraceErrors,
} from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import {
  DEFAULT_WINDOW,
  ERROR_CAP,
  ERROR_TRACE_CAP,
  TRACE_SCAN_CAP,
  TRACE_SCAN_PAGE,
} from '#/limits.ts';
import {
  commandLine,
  EXIT_CODES,
  ExitWith,
  emitRecord,
  emptyNotice,
  outputMode,
  renderError,
  retentionNoteFor,
  shortId,
} from '#/output.ts';
import { globalOptions, resolveErrorScope } from '#/resolve.ts';
import { parseWhen } from '#/time.ts';

const formatGroup = (record: ErrorGroupRecord): string => {
  const deploys =
    record.deploymentIds.length === 0
      ? ''
      : ` deploys ${record.deploymentIds.map(shortId).join(',')}`;
  const trace =
    record.traceId === undefined ? '' : ` trace=${shortId(record.traceId)}`;
  const origin = record.source === 'traces' ? ' [traces]' : '';
  const sample = record.sample.split('\n').slice(0, 1).join('');
  return `${String(record.count).padStart(5)}x ${record.service}${origin} ${record.firstSeen} -> ${record.lastSeen}${deploys}${trace}\n       ${sample}\n       $ ${record.hint}`;
};

interface ErrorGroupRecord extends ErrorGroup {
  readonly provider: string;
  /** Absent for trace groups: Jaeger has no environment. */
  readonly environment?: string;
  readonly hint: string;
  /** True when a cap was hit, so counts undercount. */
  readonly partial: boolean;
}

const SERVICE_CONCURRENCY = 4;

const SOURCES = ['logs', 'traces'] as const;

export const errorsOptions = {
  ...globalOptions,
  service: Argument.String('service').pipe(
    Argument.withDescription(
      'service name from the config; omit to cover all services of the project',
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
  source: Flag.Literals('source', SOURCES).pipe(
    Flag.withDescription(
      'only log groups, or only trace groups (default: both; the trace side runs only when the project has `tracing`)',
    ),
    Flag.optional,
  ),
};

interface Failure {
  readonly label: string;
  readonly error: unknown;
}

const failed = (label: string) => (error: unknown) =>
  Effect.succeed({ _tag: 'failed' as const, label, error });

export const errorsCommand = Command.make('errors', errorsOptions, (args) =>
  Effect.gen(function* () {
    const now = new Date();
    const sinceText = Option.getOrElse(args.since, () => DEFAULT_WINDOW);
    const since = yield* parseWhen('--since', sinceText, now);
    const until = Option.isSome(args.until)
      ? yield* parseWhen('--until', args.until.value, now)
      : undefined;
    const scope = yield* resolveErrorScope(args, args.service, args.source);
    const query = {
      since,
      until,
      levels: ['error', 'fatal'] as const,
      limit: ERROR_CAP,
    };
    const fetchLogs = (entry: (typeof scope.entries)[number]) =>
      Effect.gen(function* () {
        const built = yield* entry.build;
        const page = yield* built.source.logs({
          ...query,
          levels: [...query.levels],
        });
        return { name: entry.name, ...built, page };
      }).pipe(
        Effect.map((service) => ({ _tag: 'fetched' as const, service })),
        Effect.catch(failed(entry.name)),
      );
    const scanTraces = Effect.gen(function* () {
      if (scope.traces === undefined) return [];
      const traceScope = scope.traces;
      const backendResult = yield* traceScope.backend.pipe(Effect.result);
      if (backendResult._tag === 'Failure') {
        return [
          {
            _tag: 'failed' as const,
            label: 'tracing',
            error: backendResult.failure,
          },
        ];
      }
      const backend = backendResult.success;
      const getTrace = memoizeGetTrace(backend);
      return yield* Effect.forEach(
        traceScope.services,
        (service) =>
          scanTraceErrors({
            backend,
            getTrace,
            service: service.name,
            otelService: service.otelService,
            since,
            until: until ?? now,
            maxErrorTraces: ERROR_TRACE_CAP,
            scanCap: TRACE_SCAN_CAP,
            pageSize: TRACE_SCAN_PAGE,
          }).pipe(
            Effect.map((scan) => ({
              _tag: 'scanned' as const,
              name: service.name,
              scan,
            })),
            Effect.catch(failed(`${service.name} (traces)`)),
          ),
        { concurrency: SERVICE_CONCURRENCY },
      );
    });

    const [logOutcomes, traceOutcomes] = yield* Effect.all(
      [
        Effect.forEach(scope.entries, fetchLogs, {
          concurrency: SERVICE_CONCURRENCY,
        }),
        scanTraces,
      ],
      { concurrency: 2 },
    );
    const outcomes = [...logOutcomes, ...traceOutcomes];
    const single = outcomes[0];
    // One service has nothing to degrade to: its error keeps its own message and exit code.
    if (outcomes.length === 1 && single?._tag === 'failed') {
      return yield* Effect.fail(single.error);
    }
    const fetched = logOutcomes.flatMap((o) =>
      o._tag === 'fetched' ? [o.service] : [],
    );
    const scanned = traceOutcomes.flatMap((o) =>
      o._tag === 'scanned' ? [o] : [],
    );
    const failures: ReadonlyArray<Failure> = outcomes.flatMap((o) =>
      o._tag === 'failed' ? [o] : [],
    );

    const partialServices = new Set(
      fetched
        .filter((service) => service.page.next !== undefined)
        .map((service) => service.name),
    );
    const partialTraceServices = new Set(
      scanned.filter((o) => o.scan.partial).map((o) => o.name),
    );
    const environments = new Map(
      fetched.map((service) => [service.name, service.target] as const),
    );
    const records: LogRecord[] = fetched.flatMap(
      (service) => service.page.records,
    );
    const mode = outputMode(args.json);
    const groups = [
      ...groupErrors(coalesceMultiline(records)),
      ...scanned.flatMap((o) => o.scan.groups),
    ].sort(byFrequency);
    const globalFlags = [
      ['project', Option.getOrUndefined(args.project)],
      ['config', Option.getOrUndefined(args.config)],
    ] as const;
    for (const group of groups) {
      if (group.source === 'traces') {
        const traceId = group.traceId;
        if (traceId === undefined) {
          throw new Error(
            `trace error group "${group.fingerprint}" has no trace`,
          );
        }
        yield* emitRecord(
          mode,
          {
            ...group,
            provider: 'jaeger',
            hint: commandLine('trace', [traceId], globalFlags),
            partial: partialTraceServices.has(group.service),
          } satisfies ErrorGroupRecord,
          formatGroup,
        );
        continue;
      }
      const target = environments.get(group.service);
      if (target === undefined) {
        throw new Error(`error group for unknown service "${group.service}"`);
      }
      const hint = commandLine(
        'logs',
        [group.service],
        [
          ['project', Option.getOrUndefined(args.project)],
          ['env', Option.getOrUndefined(args.env)],
          ['config', Option.getOrUndefined(args.config)],
          ['since', sinceText],
          ['until', Option.getOrUndefined(args.until)],
          ['level', 'error,fatal'],
          ['grep', firstLine(group.sample).slice(0, 120) || undefined],
        ],
      );
      yield* emitRecord(
        mode,
        {
          ...group,
          provider: target.provider,
          environment: target.environment,
          hint,
          partial: partialServices.has(group.service),
        } satisfies ErrorGroupRecord,
        formatGroup,
      );
    }
    if (groups.length === 0 && fetched.length + scanned.length > 0) {
      const names = [
        ...new Set([
          ...fetched.map((service) => service.name),
          ...scanned.map((o) => o.name),
        ]),
      ];
      const detail =
        fetched.length === 1 && scanned.length === 0
          ? `${fetched[0]?.target.service} (${fetched[0]?.target.provider}, ${fetched[0]?.target.environment})`
          : names.join(', ');
      const retention = fetched
        .map((service) => retentionNoteFor(service.source, since, now))
        .find((note) => note !== undefined);
      const what =
        scanned.length === 0
          ? 'error logs'
          : fetched.length === 0
            ? 'error spans'
            : 'errors';
      yield* emptyNotice(
        what,
        partialTraceServices.size === 0
          ? `for ${detail} since ${since.toISOString()}`
          : `for ${detail} in the scanned range since ${since.toISOString()} (trace scan was capped; see note)`,
        retention,
      );
    }
    const labelled =
      scope.entries.length + (scope.traces?.services.length ?? 0) > 1;
    for (const service of fetched) {
      if (!partialServices.has(service.name)) continue;
      const prefix = labelled ? `${service.name}: ` : '';
      yield* Console.error(
        `note: ${prefix}hit the ${ERROR_CAP}-log cap; counts are partial (newest ${ERROR_CAP} error logs only). Narrow --since for exact counts.`,
      );
    }
    for (const outcome of scanned) {
      if (!outcome.scan.partial) continue;
      const prefix = labelled ? `${outcome.name} (traces): ` : '';
      yield* Console.error(
        `note: ${prefix}trace scan was capped (${ERROR_TRACE_CAP} error traces or ${TRACE_SCAN_CAP} traces scanned per service) after reading ${outcome.scan.errorTraces} error traces out of ${outcome.scan.scanned} scanned; older traces remain unread, so counts are partial (newest first). Narrow the window with --since for exact counts.`,
      );
    }
    for (const failure of failures) {
      const rendered = renderError(failure.error);
      yield* Console.error(
        rendered.hint === undefined
          ? `error: ${failure.label}: ${rendered.message}`
          : `error: ${failure.label}: ${rendered.message}\nhint: ${rendered.hint}`,
      );
    }
    if (failures.length > 0) {
      return yield* new ExitWith({ code: EXIT_CODES.runtime });
    }
  }),
).pipe(
  Command.withShortDescription(
    'error logs and error spans grouped by fingerprint, most frequent first',
  ),
  Command.withDescription(
    'Group error and fatal logs, plus error spans from Jaeger when the project has `tracing`, by fingerprint, most frequent first. Start here for "what is failing".',
  ),
  Command.withExamples([
    { command: 'traces errors api --since 1h' },
    {
      command: 'traces errors --since 1d --source traces',
      description: 'error spans only',
    },
    {
      command: "traces errors --source traces --json | jq -r '.hint'",
      description: 'trace commands to run',
    },
  ]),
);
