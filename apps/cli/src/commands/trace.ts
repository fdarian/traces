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
  traceId: Argument.String('traceId'),
};

export const traceCommand = Command.make('trace', traceOptions, (args) =>
  Effect.gen(function* () {
    if (!TRACE_ID.test(args.traceId)) {
      return yield* new UsageError({
        message: `"${args.traceId}" is not a trace id`,
        hint: 'pass the full 32-hex traceId (16-hex for legacy ids); `traces logs <service> --json` shows it as the top-level traceId, and the 8-char `trace=` prefix on a TTY is too short',
      });
    }
    const resolved = yield* resolveProject(args);
    const backend = yield* resolveTraceBackend(resolved);
    const rows = toSpanRows(yield* backend.getTrace(args.traceId));

    if (outputMode(args.json) === 'ndjson') {
      for (const row of rows) {
        yield* Console.log(JSON.stringify(row));
      }
      return;
    }
    for (const line of formatSpanTree(rows)) {
      yield* Console.log(line);
    }
  }),
);
