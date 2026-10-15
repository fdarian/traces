#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Cause, Console, Effect, Exit, Layer, Option } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { hoistGlobalFlags } from '#/argv.ts';
import { deploysCommand } from '#/commands/deploys.ts';
import { errorsCommand } from '#/commands/errors.ts';
import { logsCommand } from '#/commands/logs.ts';
import { secretCommand } from '#/commands/secret.ts';
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
  withoutFrameworkHelp,
  withPlainConsole,
} from '#/output.ts';
import { Secrets } from '#/secrets.ts';

const root = Command.make('traces').pipe(
  Command.withSubcommands([
    servicesCommand,
    logsCommand,
    deploysCommand,
    errorsCommand,
    secretCommand,
  ]),
);

const run = Command.runWith(root, { version: '0.0.0', renderErrors: false });

const rawArgs = hoistGlobalFlags(process.argv.slice(2));
const helpRequest = resolveHelpRequest(rawArgs);

const program = Effect.gen(function* () {
  if (helpRequest === undefined) return yield* run(rawArgs);
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
  Effect.catch((error) => {
    // Already reported by the command (partial failures); only the exit code is left to carry.
    if (error instanceof ExitWith) return Effect.fail(error);
    const rendered = renderError(error);
    return reportError(rendered).pipe(
      Effect.andThen(Effect.fail(new ExitWith({ code: rendered.code }))),
    );
  }),
);

program.pipe(
  withoutFrameworkHelp,
  withPlainConsole,
  Effect.provide(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, Secrets.layer),
  ),
  BunRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      if (Exit.isSuccess(exit)) return onExit(EXIT_CODES.ok);
      if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130);
      const failure = Cause.findErrorOption(exit.cause);
      onExit(
        Option.isSome(failure) && failure.value instanceof ExitWith
          ? failure.value.code
          : EXIT_CODES.runtime,
      );
    },
  }),
);
