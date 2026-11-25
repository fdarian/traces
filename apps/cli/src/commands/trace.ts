import { toSpanRows } from '@traces/core';
import { Console, Effect } from 'effect';
import { Argument, Command } from 'effect/cli';
import { UsageError } from '#/errors.ts';
import { formatSpanTree, outputMode } from '#/output.ts';
import {
  globalOptions,
  resolveProject,
  resolveTraceBackend,
} from '#/resolve.ts';

const TRACE_ID = /^[0-9a-f]{16}(?:[0-9a-f]{16})?$/i;

export const traceOptions = {
  ...globalOptions,
  traceId: Argument.String('traceId').pipe(
    Argument.withDescription(
      'full 32-hex trace id (16-hex legacy ids work); the traceId of a `traces logs --json` record',
    ),
  ),
};

export const traceCommand = Command.make('trace', traceOptions, (args) =>
  Effect.gen(function* () {
    if (!TRACE_ID.test(args.traceId)) {
      return yield* new UsageError({
        message: `"${args.traceId}" is not a trace id`,
        hint: 'pass the full 32-hex traceId (16-hex for legacy ids); `traces logs <service> --json` shows it as the top-level traceId, and `trace=` shows only 8 characters on a terminal, which is too short; piped output prints the full id',
      });
    }
    const resolved = yield* resolveProject(args);
    const backend = yield* resolveTraceBackend(resolved);
    const rows = toSpanRows(yield* backend.getTrace(args.traceId));

    if (outputMode(args.json) === 'json') {
      for (const row of rows) {
        yield* Console.log(JSON.stringify(row));
      }
      return;
    }
    for (const line of formatSpanTree(rows)) {
      yield* Console.log(line);
    }
  }),
).pipe(
  Command.withShortDescription('show one trace as a span tree from Jaeger'),
  Command.withDescription(
    'Fetch every span of one trace, ordered depth first. No service is needed; the project is still resolved for its `tracing` block.',
  ),
  Command.withExamples([
    { command: 'traces trace a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e' },
    {
      command:
        'traces trace a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e --json | jq \'select(.status == "error")\'',
    },
  ]),
);
