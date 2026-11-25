#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect, Layer } from 'effect';
import {
  CliConfig,
  CliError,
  CliOutput,
  Command,
  GlobalFlag,
} from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { SkillSource, skills } from 'effect-cli-skills';
import { hoistGlobalFlags } from '#/argv.ts';
import { deploysCommand } from '#/commands/deploys.ts';
import { errorsCommand } from '#/commands/errors.ts';
import { initCommand } from '#/commands/init.ts';
import { logsCommand } from '#/commands/logs.ts';
import { secretCommand } from '#/commands/secret.ts';
import { servicesCommand } from '#/commands/services.ts';
import { spansCommand } from '#/commands/spans.ts';
import { traceCommand } from '#/commands/trace.ts';
import {
  ExitWith,
  exitReport,
  parseErrorPresenter,
  renderError,
  reportError,
} from '#/output.ts';
import { Keychain, Secrets } from '#/secrets.ts';
import { skills as embeddedSkills } from '#/skills.macro.ts' with {
  type: 'macro',
};
import packageJson from '../package.json' with { type: 'json' };

const root = Command.make('traces').pipe(
  Command.withDescription(
    'read logs, deployments and traces from Vercel, Railway and Jaeger through one CLI\nAI agents: start with traces skills get core',
  ),
  Command.withSubcommands([
    initCommand,
    servicesCommand,
    logsCommand,
    deploysCommand,
    errorsCommand,
    spansCommand,
    traceCommand,
    secretCommand,
    skills({ cli: 'traces' }),
  ]),
);

const run = Command.runWith(root, { version: packageJson.version });

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
      Secrets.layer.pipe(
        Layer.provide(Keychain.layer),
        Layer.provide(BunServices.layer),
      ),
      SkillSource.inline(embeddedSkills()),
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      CliOutput.layerPresenter(parseErrorPresenter),
    ),
  ),
  BunRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      const report = exitReport(exit, Boolean(process.env.TRACES_DEBUG));
      if (report.stderr !== undefined) console.error(report.stderr);
      onExit(report.code);
    },
  }),
);
