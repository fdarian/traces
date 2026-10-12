import { type ErrorGroup, firstLine, groupErrors } from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { DEFAULT_WINDOW, ERROR_CAP } from '#/limits.ts';
import {
  commandLine,
  emitRecord,
  emptyNotice,
  outputMode,
  shortId,
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';
import { parseWhen } from '#/time.ts';

const formatGroup = (record: ErrorGroupRecord): string => {
  const deploys =
    record.deploymentIds.length === 0
      ? ''
      : ` deploys ${record.deploymentIds.map(shortId).join(',')}`;
  const sample = record.sample.split('\n').slice(0, 1).join('');
  return `${String(record.count).padStart(5)}x ${record.service} ${record.firstSeen} -> ${record.lastSeen}${deploys}\n       ${sample}\n       $ ${record.hint}`;
};

interface ErrorGroupRecord extends ErrorGroup {
  readonly provider: string;
  readonly environment: string;
  readonly hint: string;
  /** True when the fetch cap was hit, so counts undercount. */
  readonly partial: boolean;
}

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
    const resolved = yield* resolveService(args, args.service);
    const page = yield* resolved.source.logs({
      since,
      until,
      levels: ['error', 'fatal'],
      limit: ERROR_CAP,
    });
    const partial = page.next !== undefined;
    const mode = outputMode(args.json);
    const groups = groupErrors(page.records);
    for (const group of groups) {
      const hint = commandLine(
        'logs',
        [resolved.name],
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
          provider: resolved.target.provider,
          environment: resolved.target.environment,
          hint,
          partial,
        } satisfies ErrorGroupRecord,
        formatGroup,
      );
    }
    if (groups.length === 0) {
      yield* emptyNotice(
        'error logs',
        `for ${resolved.target.service} (${resolved.target.provider}, ${resolved.target.environment}) since ${since.toISOString()}`,
        resolved.source.retentionNote,
      );
    }
    if (partial) {
      yield* Console.error(
        `note: hit the ${ERROR_CAP}-log cap; counts are partial (newest ${ERROR_CAP} error logs only). Narrow --since for exact counts.`,
      );
    }
  }),
);
