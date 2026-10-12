import { Args, Command, Options } from '@effect/cli';
import { decodeCursor, encodeCursor } from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { UsageError } from '#/errors.ts';
import {
  commandLine,
  emitRecord,
  emptyNotice,
  formatDeploymentLine,
  outputMode,
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';

const MAX_LIMIT = 100;

export const deploysCommand = Command.make(
  'deploys',
  {
    ...globalOptions,
    service: Args.text({ name: 'service' }).pipe(
      Args.withDescription(
        'Service name from the config; optional when the project has exactly one',
      ),
      Args.optional,
    ),
    limit: Options.integer('limit').pipe(
      Options.withDescription(
        `Deployments per page, 1-${MAX_LIMIT} (default 10)`,
      ),
      Options.withDefault(10),
    ),
    cursor: Options.text('cursor').pipe(
      Options.withDescription('Opaque cursor from a previous "more:" line'),
      Options.optional,
    ),
  },
  (args) =>
    Effect.gen(function* () {
      if (args.limit < 1 || args.limit > MAX_LIMIT) {
        return yield* new UsageError({
          message: `--limit must be between 1 and ${MAX_LIMIT}`,
          hint: 'page further back with --cursor instead',
        });
      }
      const cursor = Option.isSome(args.cursor)
        ? yield* decodeCursor(args.cursor.value)
        : undefined;
      const resolved = yield* resolveService(args, args.service);
      const page = yield* resolved.source.deployments({
        limit: args.limit,
        cursor,
      });
      const mode = outputMode(args.json);
      for (const deployment of page.deployments) {
        yield* emitRecord(mode, deployment, formatDeploymentLine);
      }
      if (page.deployments.length === 0) {
        yield* emptyNotice(
          'deployments',
          `for ${resolved.target.service} (${resolved.target.provider}, ${resolved.target.environment})`,
          resolved.source.retentionNote,
        );
      }
      if (page.next !== undefined) {
        yield* Console.error(
          `more: ${commandLine(
            'deploys',
            [resolved.name],
            [
              ['project', Option.getOrUndefined(args.project)],
              ['env', Option.getOrUndefined(args.env)],
              ['config', Option.getOrUndefined(args.config)],
              ['json', args.json],
              ['limit', String(args.limit)],
              ['cursor', encodeCursor(page.next)],
            ],
          )}`,
        );
      }
    }),
).pipe(
  Command.withDescription(
    [
      'List deployments of a service, newest first: status, commit, branch, time, url.',
      '',
      'Examples:',
      '  traces deploys api',
      '  traces deploys api --limit 3 --json',
      '  git rev-parse HEAD   # compare with the sha of the newest "ready" deployment',
    ].join('\n'),
  ),
);
