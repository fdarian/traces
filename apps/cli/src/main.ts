#!/usr/bin/env bun
import { Command } from '@effect/cli';
import { FetchHttpClient } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Cause, Console, Effect, Exit, Layer, Option } from 'effect';
import { deploysCommand } from '#/commands/deploys.ts';
import { errorsCommand } from '#/commands/errors.ts';
import { logsCommand } from '#/commands/logs.ts';
import { servicesCommand } from '#/commands/services.ts';
import { HELP_TEXT } from '#/help.ts';
import { EXIT_CODES, ExitWith, renderError, reportError } from '#/output.ts';

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
const wantsTopLevelHelp =
  rawArgs.length === 0 ||
  (rawArgs.length === 1 && ['--help', '-h', 'help'].includes(rawArgs[0] ?? ''));
// `traces help logs` reads like `traces logs --help`.
const argv =
  rawArgs[0] === 'help' && rawArgs.length > 1
    ? [...process.argv.slice(0, 2), ...rawArgs.slice(1), '--help']
    : process.argv;

const program = wantsTopLevelHelp
  ? Console.log(HELP_TEXT.trimEnd())
  : run(argv).pipe(
      Effect.catchAll((error) => {
        const rendered = renderError(error);
        return reportError(rendered).pipe(
          Effect.zipRight(Effect.fail(new ExitWith({ code: rendered.code }))),
        );
      }),
    );

program.pipe(
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
