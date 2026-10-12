import { Args, Command, Options } from '@effect/cli';
import { type ErrorGroup, firstLine, groupErrors } from '@traces/core';
import { Console, Effect, Option } from 'effect';
import {
  commandLine,
  emitRecord,
  emptyNotice,
  outputMode,
  shortId,
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';
import { parseWhen } from '#/time.ts';

const ERROR_CAP = 2000;
const DEFAULT_WINDOW = '1h';

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

export const errorsCommand = Command.make(
  'errors',
  {
    ...globalOptions,
    service: Args.text({ name: 'service' }).pipe(
      Args.withDescription(
        'Service name from the config; optional when the project has exactly one',
      ),
      Args.optional,
    ),
    since: Options.text('since').pipe(
      Options.withDescription(
        `Window start: 30m | 1h | 2d | ISO timestamp (default ${DEFAULT_WINDOW})`,
      ),
      Options.optional,
    ),
    until: Options.text('until').pipe(
      Options.withDescription(
        'Window end, same formats as --since (default now)',
      ),
      Options.optional,
    ),
  },
  (args) =>
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
).pipe(
  Command.withDescription(
    [
      'Group error and fatal logs by fingerprint (ids and numbers in the first line are collapsed), most frequent first.',
      'Each group carries a ready-to-run `traces logs ... --grep` hint.',
      '',
      'Examples:',
      '  traces errors api --since 1h',
      '  traces errors api --since 2d --json',
    ].join('\n'),
  ),
);
