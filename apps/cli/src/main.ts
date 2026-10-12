#!/usr/bin/env bun
import { Command } from '@effect/cli';
import { FetchHttpClient } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Cause, Console, Effect, Exit, Layer, Option } from 'effect';
import { deploysCommand } from '#/commands/deploys.ts';
import { errorsCommand } from '#/commands/errors.ts';
import { logsCommand } from '#/commands/logs.ts';
import { servicesCommand } from '#/commands/services.ts';
import { UsageError } from '#/errors.ts';
import {
  COMMAND_NAMES,
  HELP_TEXT,
  renderCommandHelp,
  resolveHelpRequest,
} from '#/help.ts';
import {
  EXIT_CODES,
  ExitWith,
  renderError,
  reportError,
  withPlainConsole,
} from '#/output.ts';

const root = Command.make('traces').pipe(
  Command.withSubcommands([
    servicesCommand,
    logsCommand,
    deploysCommand,
    errorsCommand,
  ]),
);

const run = Command.run(root, { name: 'traces', version: '0.0.0' });

const rawArgs = process.argv.slice(2);
const helpRequest = resolveHelpRequest(rawArgs);

const program = Effect.gen(function* () {
  if (helpRequest === undefined) return yield* run(process.argv);
  switch (helpRequest.kind) {
    case 'top':
      return yield* Console.log(HELP_TEXT);
    case 'command':
      return yield* Console.log(renderCommandHelp(helpRequest.name));
    case 'unknown':
      return yield* new UsageError({
        message: `no command named "${helpRequest.name}"`,
        hint: `commands: ${COMMAND_NAMES.join(', ')}`,
      });
  }
}).pipe(
  Effect.catchAll((error) => {
    const rendered = renderError(error);
    return reportError(rendered).pipe(
      Effect.zipRight(Effect.fail(new ExitWith({ code: rendered.code }))),
    );
  }),
);

program.pipe(
  withPlainConsole,
  Effect.provide(Layer.mergeAll(BunContext.layer, FetchHttpClient.layer)),
  BunRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      if (Exit.isSuccess(exit)) return onExit(EXIT_CODES.ok);
      if (Cause.isInterruptedOnly(exit.cause)) return onExit(130);
      const failure = Cause.failureOption(exit.cause);
      onExit(
        Option.isSome(failure) && failure.value instanceof ExitWith
          ? failure.value.code
          : EXIT_CODES.runtime,
      );
    },
  }),
);
