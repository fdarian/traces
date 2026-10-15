import {
  type ErrorGroup,
  firstLine,
  groupErrors,
  type LogRecord,
} from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { DEFAULT_WINDOW, ERROR_CAP } from '#/limits.ts';
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
import { globalOptions, resolveServices } from '#/resolve.ts';
import { parseWhen } from '#/time.ts';

const formatGroup = (record: ErrorGroupRecord): string => {
  const deploys =
    record.deploymentIds.length === 0
      ? ''
      : ` deploys ${record.deploymentIds.map(shortId).join(',')}`;
  const trace =
    record.traceId === undefined ? '' : ` trace=${shortId(record.traceId)}`;
  const sample = record.sample.split('\n').slice(0, 1).join('');
  return `${String(record.count).padStart(5)}x ${record.service} ${record.firstSeen} -> ${record.lastSeen}${deploys}${trace}\n       ${sample}\n       $ ${record.hint}`;
};

interface ErrorGroupRecord extends ErrorGroup {
  readonly provider: string;
  readonly environment: string;
  readonly hint: string;
  /** True when the fetch cap was hit, so counts undercount. */
  readonly partial: boolean;
}

const SERVICE_CONCURRENCY = 4;

export const errorsOptions = {
  ...globalOptions,
  service: Argument.String('service').pipe(Argument.optional),
  since: Flag.String('since').pipe(Flag.optional),
  until: Flag.String('until').pipe(Flag.optional),
};

export const errorsCommand = Command.make('errors', errorsOptions, (args) =>
  Effect.gen(function* () {
    const now = new Date();
    const sinceText = Option.getOrElse(args.since, () => DEFAULT_WINDOW);
    const since = yield* parseWhen('--since', sinceText, now);
    const until = Option.isSome(args.until)
      ? yield* parseWhen('--until', args.until.value, now)
      : undefined;
    const selection = yield* resolveServices(args, args.service);
    const query = {
      since,
      until,
      levels: ['error', 'fatal'] as const,
      limit: ERROR_CAP,
    };
    const fetchService = (entry: (typeof selection.entries)[number]) =>
      Effect.gen(function* () {
        const built = yield* entry.build;
        const page = yield* built.source.logs({
          ...query,
          levels: [...query.levels],
        });
        return { name: entry.name, ...built, page };
      });
    const outcomes = yield* Effect.forEach(
      selection.entries,
      (entry) =>
        fetchService(entry).pipe(
          Effect.map((service) => ({ _tag: 'fetched' as const, service })),
          Effect.catch((error) =>
            Effect.succeed({
              _tag: 'failed' as const,
              name: entry.name,
              error,
            }),
          ),
        ),
      { concurrency: SERVICE_CONCURRENCY },
    );
    const only = outcomes[0];
    // One service has nothing to degrade to: its error keeps its own message and exit code.
    if (outcomes.length === 1 && only?._tag === 'failed') {
      return yield* Effect.fail(only.error);
    }
    const fetched = outcomes.flatMap((o) =>
      o._tag === 'fetched' ? [o.service] : [],
    );
    const failures = outcomes.flatMap((o) => (o._tag === 'failed' ? [o] : []));

    const partialServices = new Set(
      fetched
        .filter((service) => service.page.next !== undefined)
        .map((service) => service.name),
    );
    const environments = new Map(
      fetched.map((service) => [service.name, service.target] as const),
    );
    const records: LogRecord[] = fetched.flatMap(
      (service) => service.page.records,
    );
    const mode = outputMode(args.json);
    const groups = groupErrors(records);
    for (const group of groups) {
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
    if (groups.length === 0 && fetched.length > 0) {
      const scope =
        fetched.length === 1
          ? `${fetched[0]?.target.service} (${fetched[0]?.target.provider}, ${fetched[0]?.target.environment})`
          : fetched.map((service) => service.name).join(', ');
      const retention = fetched
        .map((service) => retentionNoteFor(service.source, since, now))
        .find((note) => note !== undefined);
      yield* emptyNotice(
        'error logs',
        `for ${scope} since ${since.toISOString()}`,
        retention,
      );
    }
    for (const service of fetched) {
      if (!partialServices.has(service.name)) continue;
      const prefix = selection.entries.length === 1 ? '' : `${service.name}: `;
      yield* Console.error(
        `note: ${prefix}hit the ${ERROR_CAP}-log cap; counts are partial (newest ${ERROR_CAP} error logs only). Narrow --since for exact counts.`,
      );
    }
    for (const failure of failures) {
      const rendered = renderError(failure.error);
      yield* Console.error(
        rendered.hint === undefined
          ? `error: ${failure.name}: ${rendered.message}`
          : `error: ${failure.name}: ${rendered.message}\nhint: ${rendered.hint}`,
      );
    }
    if (failures.length > 0) {
      return yield* new ExitWith({ code: EXIT_CODES.runtime });
    }
  }),
);
