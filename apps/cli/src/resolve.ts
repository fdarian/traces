import { Options } from '@effect/cli';
import {
  type LogSource,
  makeRailwaySource,
  makeVercelSource,
  type ServiceTarget,
} from '@traces/core';
import { Effect, Option } from 'effect';
import {
  type ProjectConfig,
  readConfig,
  resolveDefaultConfigPath,
  type ServiceConfig,
} from '#/config.ts';
import { UsageError } from '#/errors.ts';
import {
  captureInvocation,
  resolveMatcherPaths,
  selectProject,
} from '#/project-match.ts';
import { findVercelToken } from '#/vercel-token.ts';

export const globalOptions = {
  project: Options.text('project').pipe(
    Options.withDescription(
      'Project name from the config; overrides cwd matching',
    ),
    Options.optional,
  ),
  env: Options.text('env').pipe(
    Options.withDescription(
      'Railway environment name, or Vercel target (production | preview)',
    ),
    Options.optional,
  ),
  config: Options.text('config').pipe(
    Options.withDescription(
      'Config file path (default: $XDG_CONFIG_HOME/traces/config.json)',
    ),
    Options.optional,
  ),
  json: Options.boolean('json').pipe(
    Options.withDescription('Force NDJSON output even on a TTY'),
  ),
};

export interface GlobalFlags {
  readonly project: Option.Option<string>;
  readonly env: Option.Option<string>;
  readonly config: Option.Option<string>;
  readonly json: boolean;
}

export interface ResolvedProject {
  readonly configPath: string;
  readonly projectName: string;
  readonly matchedBy: 'flag' | 'path' | 'git';
  readonly project: ProjectConfig;
}

export const resolveProject = (flags: GlobalFlags) =>
  Effect.gen(function* () {
    const configPath = Option.isSome(flags.config)
      ? flags.config.value
      : yield* resolveDefaultConfigPath;
    const config = yield* readConfig(configPath);
    const invocation = yield* captureInvocation(process.cwd()).pipe(
      Effect.mapError(
        (error) =>
          new UsageError({
            message: `cannot inspect the current directory: ${error.message}`,
            hint: 'run from an existing directory',
          }),
      ),
    );
    const matcherPaths = yield* resolveMatcherPaths(config);
    const selected = yield* selectProject({
      config,
      configPath,
      invocation,
      matcherPaths,
      projectFlag: flags.project,
    });
    return {
      configPath,
      projectName: selected.name,
      matchedBy: selected.matchedBy,
      project: selected.project,
    } satisfies ResolvedProject;
  });

export const selectService = (
  resolved: ResolvedProject,
  requested: Option.Option<string>,
) => {
  const names = Object.keys(resolved.project.services);
  const available = `available services in "${resolved.projectName}": ${names.join(', ')}`;
  if (Option.isSome(requested)) {
    const config = resolved.project.services[requested.value];
    return config === undefined
      ? Effect.fail(
          new UsageError({
            message: `no service named "${requested.value}" in project "${resolved.projectName}"`,
            hint: available,
          }),
        )
      : Effect.succeed({ name: requested.value, config });
  }
  const only = names[0];
  const config =
    only === undefined ? undefined : resolved.project.services[only];
  if (names.length === 1 && only !== undefined && config !== undefined) {
    return Effect.succeed({ name: only, config });
  }
  return Effect.fail(
    new UsageError({
      message: `project "${resolved.projectName}" has ${names.length} services; pick one`,
      hint: available,
    }),
  );
};

const VERCEL_TARGETS = ['production', 'preview'];

export const buildTarget = (
  name: string,
  config: ServiceConfig,
  envFlag: Option.Option<string>,
): Effect.Effect<ServiceTarget, UsageError> => {
  if (config.provider === 'railway') {
    return Effect.succeed({
      provider: 'railway',
      service: name,
      project: config.project,
      serviceName: config.service,
      environment: Option.isSome(envFlag)
        ? envFlag.value
        : (config.environment ?? 'production'),
    });
  }
  const environment = Option.isSome(envFlag) ? envFlag.value : 'production';
  if (!VERCEL_TARGETS.includes(environment)) {
    return Effect.fail(
      new UsageError({
        message: `"${environment}" is not a Vercel target for service "${name}"`,
        hint: 'use --env production or --env preview',
      }),
    );
  }
  return Effect.succeed({
    provider: 'vercel',
    service: name,
    project: config.project,
    ...(config.team === undefined ? {} : { team: config.team }),
    environment,
  });
};

export const buildSource = (target: ServiceTarget) =>
  target.provider === 'railway'
    ? makeRailwaySource(target)
    : Effect.gen(function* () {
        const token = yield* findVercelToken;
        return yield* makeVercelSource(target, token.token);
      });

export interface ResolvedService {
  readonly resolved: ResolvedProject;
  readonly name: string;
  readonly target: ServiceTarget;
  readonly source: LogSource;
}

export const resolveService = (
  flags: GlobalFlags,
  service: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(flags);
    const selected = yield* selectService(resolved, service);
    const target = yield* buildTarget(
      selected.name,
      selected.config,
      flags.env,
    );
    const source = yield* buildSource(target);
    return {
      resolved,
      name: selected.name,
      target,
      source,
    } satisfies ResolvedService;
  });
