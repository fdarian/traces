import { decodeCursor, encodeCursor } from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { UsageError } from '#/errors.ts';
import { DEPLOYS_LIMIT } from '#/limits.ts';
import {
  commandLine,
  emitRecord,
  emptyNotice,
  formatDeploymentLine,
  outputMode,
} from '#/output.ts';
import { globalOptions, resolveService } from '#/resolve.ts';

export const deploysOptions = {
  ...globalOptions,
  service: Argument.String('service').pipe(Argument.optional),
  limit: Flag.Int('limit').pipe(Flag.withDefault(DEPLOYS_LIMIT.default)),
  cursor: Flag.String('cursor').pipe(Flag.optional),
};

export const deploysCommand = Command.make('deploys', deploysOptions, (args) =>
  Effect.gen(function* () {
    if (args.limit < 1 || args.limit > DEPLOYS_LIMIT.max) {
      return yield* new UsageError({
        message: `--limit must be between 1 and ${DEPLOYS_LIMIT.max}`,
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
);
