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
import { parseInstant, parseWhen } from '#/time.ts';

const formatGroup = (record: ErrorGroupRecord): string => {
  const deploys =
    record.deploymentIds.length === 0
      ? ''
      : ` deploys ${record.deploymentIds.map(shortId).join(',')}`;
  const trace =
    record.traceId === undefined ? '' : ` trace=${shortId(record.traceId)}`;
  const origin = record.source === 'traces' ? ' [traces]' : '';
  const fresh = record.new === true ? ' NEW' : '';
  const sample = record.sample.split('\n').slice(0, 1).join('');
  return `${String(record.count).padStart(5)}x ${record.service}${origin}${fresh} ${record.firstSeen} -> ${record.lastSeen}${deploys}${trace}\n       ${sample}\n       $ ${record.hint}`;
};

interface ErrorGroupRecord extends ErrorGroup {
  readonly provider: string;
  /** Absent for trace groups: Jaeger has no environment. */
  readonly environment?: string;
  readonly hint: string;
  /** True when a cap was hit, so counts undercount. */
  readonly partial: boolean;
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
  service: Argument.String('service').pipe(Argument.optional),
  since: Flag.String('since').pipe(Flag.optional),
  until: Flag.String('until').pipe(Flag.optional),
  source: Flag.Literals('source', SOURCES).pipe(Flag.optional),
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
        `${name}: ${deploySinceText(window.deployment, window.since)}; ${baselineText(window)}`,
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
            ...deployFields(group),
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
          ...deployFields(group),
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
        partialTraceServices.size === 0
          ? `for ${detail} ${sinceLabel}`
          : `for ${detail} in the scanned range ${sinceLabel} (trace scan was capped; see note)`,
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
);
