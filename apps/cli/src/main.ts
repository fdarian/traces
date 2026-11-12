#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import {
  CliConfig,
  CliError,
  CliOutput,
  Command,
  GlobalFlag,
} from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { hoistGlobalFlags } from '#/argv.ts';
import { deploysCommand } from '#/commands/deploys.ts';
import { errorsCommand } from '#/commands/errors.ts';
import { logsCommand } from '#/commands/logs.ts';
import { secretCommand } from '#/commands/secret.ts';
import { servicesCommand } from '#/commands/services.ts';
import { spansCommand } from '#/commands/spans.ts';
import { traceCommand } from '#/commands/trace.ts';
import {
  EXIT_CODES,
  ExitWith,
  parseErrorPresenter,
  renderError,
  reportError,
} from '#/output.ts';
import { Secrets } from '#/secrets.ts';

const root = Command.make('traces').pipe(
  Command.withDescription(
    'read logs, deployments and traces from Vercel, Railway and Jaeger through one CLI',
  ),
  Command.withSubcommands([
    servicesCommand,
    logsCommand,
    deploysCommand,
    errorsCommand,
    spansCommand,
    traceCommand,
    secretCommand,
  ]),
);

const run = Command.runWith(root, { version: '0.0.0' });

const program = run(hoistGlobalFlags(process.argv.slice(2))).pipe(
  Effect.catch((error) => {
    // Already reported by the command (partial failures); only the exit code is left to carry.
    if (error instanceof ExitWith) return Effect.fail(error);
    // `traces` with no arguments: the framework already printed the root help.
    if (
      CliError.isCliError(error) &&
      error._tag === 'ShowHelp' &&
      error.errors.length === 0
    ) {
      return Effect.void;
    }
    const rendered = renderError(error);
    return reportError(rendered).pipe(
      Effect.andThen(Effect.fail(new ExitWith({ code: rendered.code }))),
    );
  }),
);

program.pipe(
  Effect.provide(
    Layer.mergeAll(
      BunServices.layer,
      FetchHttpClient.layer,
      Secrets.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
      CliOutput.layerPresenter(parseErrorPresenter),
    ),
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
