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
  baselineKey,
  baselineText,
  type DeployWindow,
  deploySinceText,
  isNewGroup,
  logBaseline,
  resolveDeployWindow,
} from '#/deploy-window.ts';
import { UsageError } from '#/errors.ts';
import {
  DEFAULT_WINDOW,
  ERROR_CAP,
  ERROR_TRACE_CAP,
  TRACE_SCAN_CAP,
  TRACE_SCAN_PAGE,
} from '#/limits.ts';
import {
  commandLine,
  displayId,
  EXIT_CODES,
  ExitWith,
  emitRecord,
  emptyNotice,
  outputMode,
  renderError,
  retentionNoteFor,
  stderrIsTerminal,
  stdoutIsTerminal,
} from '#/output.ts';
import {
  collectCoverage,
  coverageNote,
  partialFields,
} from '#/partial-coverage.ts';
import { globalOptions, resolveErrorScope } from '#/resolve.ts';
import { parseInstant, parseWhen } from '#/time.ts';

export const formatGroup = (
  record: ErrorGroupRecord,
  terminal: boolean,
): string => {
  const deploys =
    record.deploymentIds.length === 0
      ? ''
      : ` deploys ${record.deploymentIds.map((id) => displayId(id, terminal)).join(',')}`;
  const trace =
    record.traceId === undefined
      ? ''
      : ` trace=${displayId(record.traceId, terminal)}`;
  const origin = record.source === 'traces' ? ' [traces]' : '';
  const fresh = record.new === true ? ' NEW' : '';
  const count = `${record.count}x`;
  const counted =
    record.lines === undefined || record.lines === record.count
      ? count
      : `${count} (${record.lines} lines)`;
  const sample = record.sample.split('\n').slice(0, 1).join('');
  return `${counted.padStart(6)} ${record.service}${origin}${fresh} ${record.firstSeen} -> ${record.lastSeen}${deploys}${trace}\n       ${sample}\n       $ ${record.hint}`;
};

export interface ErrorGroupRecord extends ErrorGroup {
  readonly provider: string;
  /** Absent for trace groups: Jaeger has no environment. */
  readonly environment?: string;
  readonly hint: string;
  /** True when a cap was hit, so counts undercount. */
  readonly partial: boolean;
  /** Set with `partial`: the counts cover this instant to the window end, not the whole window. */
  readonly countedSince?: string;
  /** `--since deploy` only: no baseline error in this service shares the fingerprint. */
  readonly new?: boolean;
  /** `--since deploy` only: the deploy the service's window starts at. */
  readonly deploymentId?: string;
  readonly deployedAt?: string;
}

const SERVICE_CONCURRENCY = 4;

const SOURCES = ['logs', 'traces'] as const;

export const errorsOptions = {
  ...globalOptions,
  service: Argument.String('service').pipe(
    Argument.withDescription(
      "service name from the config; omit to cover all services of the project. A name the config doesn't list is tried as a Railway service when all the config's Railway services share one Railway project and environment (stderr says so); otherwise exit 2",
    ),
    Argument.optional,
  ),
  since: Flag.String('since').pipe(
    Flag.withDescription(
      `30m | 1h | 2d | ISO timestamp | deploy (default ${DEFAULT_WINDOW}). deploy: each service's window starts at its own latest ready deploy, and groups carry new, deploymentId and deployedAt`,
    ),
    Flag.optional,
  ),
  until: Flag.String('until').pipe(
    Flag.withDescription(
      'window end, same formats except deploy (default now)',
    ),
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
    const when = yield* parseWhen('--since', sinceText, now);
    const deployMode = when._tag === 'deploy';
    const until = Option.isSome(args.until)
      ? yield* parseInstant('--until', args.until.value, now)
      : undefined;
    const scope = yield* resolveErrorScope(args, args.service, args.source);

    // Each service anchors on its own latest ready deploy, so its window is settled before either side reads.
    const prepareTargets = new Map(
      scope.entries.map((entry) => [entry.name, entry] as const),
    );
    if (deployMode) {
      for (const service of scope.traces?.services ?? []) {
        if (service.build !== undefined && !prepareTargets.has(service.name)) {
          prepareTargets.set(service.name, {
            name: service.name,
            build: service.build,
          });
        }
      }
      if (prepareTargets.size === 0) {
        return yield* new UsageError({
          message: '--since deploy needs a service with a log provider',
          hint: 'every service in scope is trace-only and has no deploys; use a duration or an ISO timestamp',
        });
      }
    }
    const stderrTerminal = stderrIsTerminal();
    const prepare = (entry: {
      readonly name: string;
      readonly build: (typeof scope.entries)[number]['build'];
    }) =>
      Effect.gen(function* () {
        const built = yield* entry.build;
        if (when._tag === 'instant') {
          return { built, since: when.at, window: undefined };
        }
        const window = yield* resolveDeployWindow(
          built.source,
          entry.name,
          until,
          now,
          stderrTerminal,
        );
        return { built, since: window.since, window };
      }).pipe(
        Effect.result,
        Effect.map((result) => [entry.name, result] as const),
      );
    const prepared = new Map(
      yield* Effect.forEach([...prepareTargets.values()], prepare, {
        concurrency: SERVICE_CONCURRENCY,
      }),
    );

    const fetchLogs = (entry: (typeof scope.entries)[number]) =>
      Effect.gen(function* () {
        const outcome = prepared.get(entry.name);
        if (outcome === undefined) {
          throw new Error(`service "${entry.name}" was not prepared`);
        }
        if (outcome._tag === 'Failure')
          return yield* Effect.fail(outcome.failure);
        const context = outcome.success;
        const page = yield* context.built.source.logs({
          since: context.since,
          until,
          levels: ['error', 'fatal'],
          limit: ERROR_CAP,
        });
        const baseline =
          context.window === undefined
            ? undefined
            : yield* logBaseline(context.built.source, context.window);
        return {
          name: entry.name,
          ...context.built,
          since: context.since,
          window: context.window,
          baseline,
          page,
        };
      }).pipe(
        Effect.map((service) => ({ _tag: 'fetched' as const, service })),
        Effect.catch(failed(entry.name)),
      );
    const scanTraces = Effect.gen(function* () {
      if (scope.traces === undefined) return [];
      const traceScope = scope.traces;
      const scannable = traceScope.services.filter(
        (service) => !deployMode || service.build !== undefined,
      );
      for (const service of traceScope.services) {
        if (scannable.includes(service)) continue;
        yield* Console.error(
          `${service.name}: trace-only, no deploys; skipped`,
        );
      }
      if (scannable.length === 0) return [];
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
      const scan = (
        service: (typeof scannable)[number],
        window: { readonly since: Date; readonly until: Date },
      ) =>
        scanTraceErrors({
          backend,
          getTrace,
          service: service.name,
          otelService: service.otelService,
          since: window.since,
          until: window.until,
          maxErrorTraces: ERROR_TRACE_CAP,
          scanCap: TRACE_SCAN_CAP,
          pageSize: TRACE_SCAN_PAGE,
        });
      return yield* Effect.forEach(
        scannable,
        (service) =>
          Effect.gen(function* () {
            const outcome = prepared.get(service.name);
            if (when._tag === 'instant') {
              const range = { since: when.at, until: until ?? now };
              return {
                _tag: 'scanned' as const,
                name: service.name,
                since: range.since,
                window: undefined,
                scan: yield* scan(service, range),
                baseline: undefined,
              };
            }
            if (outcome === undefined) {
              throw new Error(`service "${service.name}" was not prepared`);
            }
            if (outcome._tag === 'Failure') {
              // A service on the log side already reported its failure.
              return scope.entries.some((entry) => entry.name === service.name)
                ? { _tag: 'skipped' as const }
                : yield* Effect.fail(outcome.failure);
            }
            const window = outcome.success.window;
            if (window === undefined) {
              throw new Error(`service "${service.name}" has no deploy window`);
            }
            const current = yield* scan(service, {
              since: window.since,
              until: until ?? now,
            });
            const before = yield* scan(service, {
              since: window.baselineSince,
              until: window.since,
            });
            return {
              _tag: 'scanned' as const,
              name: service.name,
              since: window.since,
              window,
              scan: current,
              baseline: {
                fingerprints: new Set(
                  before.groups.map((group) => group.fingerprint),
                ),
                capped: before.partial,
              },
            };
          }).pipe(Effect.catch(failed(`${service.name} (traces)`))),
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
    const outcomes = [...logOutcomes, ...traceOutcomes].filter(
      (outcome) => outcome._tag !== 'skipped',
    );
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

    const coverages = collectCoverage(fetched, scanned, {
      logs: ERROR_CAP,
      errorTraces: ERROR_TRACE_CAP,
      scanned: TRACE_SCAN_CAP,
    });
    const environments = new Map(
      fetched.map((service) => [service.name, service.target] as const),
    );
    const records: LogRecord[] = fetched.flatMap(
      (service) => service.page.records,
    );
    const windows = new Map<string, DeployWindow>();
    const baselines = new Map<string, ReadonlySet<string>>();
    for (const service of fetched) {
      if (service.window !== undefined)
        windows.set(service.name, service.window);
      if (service.baseline !== undefined) {
        baselines.set(
          baselineKey({ source: 'logs', service: service.name }),
          service.baseline.fingerprints,
        );
      }
    }
    for (const outcome of scanned) {
      if (outcome.window !== undefined) {
        windows.set(outcome.name, outcome.window);
      }
      if (outcome.baseline !== undefined) {
        baselines.set(
          baselineKey({ source: 'traces', service: outcome.name }),
          outcome.baseline.fingerprints,
        );
      }
    }
    for (const [name, window] of windows) {
      yield* Console.error(
        `${name}: ${deploySinceText(window.deployment, window.since, stderrTerminal)}; ${baselineText(window)}`,
      );
    }
    const deployFields = (group: ErrorGroup) => {
      if (!deployMode) return {};
      const window = windows.get(group.service);
      if (window === undefined) {
        throw new Error(
          `error group for service "${group.service}" has no deploy window`,
        );
      }
      return {
        new: isNewGroup(group, baselines),
        deploymentId: window.deployment.id,
        deployedAt: window.since.toISOString(),
      };
    };
    const mode = outputMode(args.json);
    const terminal = stdoutIsTerminal();
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
            ...partialFields(coverages, group),
            ...deployFields(group),
          } satisfies ErrorGroupRecord,
          (group) => formatGroup(group, terminal),
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
          ...partialFields(coverages, group),
          ...deployFields(group),
        } satisfies ErrorGroupRecord,
        (group) => formatGroup(group, terminal),
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
        .map((service) => retentionNoteFor(service.source, service.since, now))
        .find((note) => note !== undefined);
      const sinceLabel = deployMode
        ? 'since the latest ready deploy'
        : `since ${(when._tag === 'instant' ? when.at : now).toISOString()}`;
      const what =
        scanned.length === 0
          ? 'error logs'
          : fetched.length === 0
            ? 'error spans'
            : 'errors';
      yield* emptyNotice(
        what,
        scanned.every((o) => !o.scan.partial)
          ? `for ${detail} ${sinceLabel}`
          : `for ${detail} in the scanned range ${sinceLabel} (trace scan was capped; see note)`,
        retention,
      );
    }
    const labelled =
      scope.entries.length + (scope.traces?.services.length ?? 0) > 1;
    for (const coverage of coverages.values()) {
      yield* Console.error(coverageNote(coverage, until ?? now, labelled));
    }
    for (const service of fetched) {
      if (service.baseline?.capped !== true) continue;
      yield* Console.error(
        `note: ${service.name}: the baseline hit the ${ERROR_CAP}-log cap; \`new\` may over-report for this service.`,
      );
    }
    for (const outcome of scanned) {
      if (outcome.baseline?.capped !== true) continue;
      yield* Console.error(
        `note: ${outcome.name} (traces): the baseline trace scan was capped; \`new\` may over-report for this service.`,
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
      command: 'traces errors --since deploy',
      description: 'then read the groups with new: true',
    },
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
