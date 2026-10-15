import {
  type LogSource,
  makeRailwaySource,
  makeVercelSource,
  type ServiceTarget,
} from '@traces/core';
import { Effect, Option } from 'effect';
import { Flag } from 'effect/cli';
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
  project: Flag.String('project').pipe(Flag.optional),
  env: Flag.String('env').pipe(Flag.optional),
  config: Flag.String('config').pipe(Flag.optional),
  json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
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

/**
 * With a service requested, or a single-service project, fails like `resolveService`;
 * otherwise every service of the project. Each entry's `build` is deferred so one
 * service's missing token or bad target fails alone instead of aborting the others.
 */
export const resolveServices = (
  flags: GlobalFlags,
  requested: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(flags);
    const configs = Option.isSome(requested)
      ? [yield* selectService(resolved, requested)]
      : Object.entries(resolved.project.services).map(([name, config]) => ({
          name,
          config,
        }));
    const entries = configs.map((selected) => ({
      name: selected.name,
      build: Effect.gen(function* () {
        const target = yield* buildTarget(
          selected.name,
          selected.config,
          flags.env,
        );
        const source = yield* buildSource(target);
        return { target, source };
      }),
    }));
    return { resolved, entries };
  });
