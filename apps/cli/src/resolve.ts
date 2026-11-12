import {
  type LogSource,
  makeJaegerBackend,
  makeRailwaySource,
  makeVercelSource,
  type ServiceTarget,
} from '@traces/core';
import { Config, Effect, Option } from 'effect';
import { Flag } from 'effect/cli';
import {
  type HeaderValue,
  hasLogProvider,
  type LogServiceConfig,
  otelServiceName,
  type ProjectConfig,
  readConfig,
  resolveDefaultConfigPath,
  type ServiceConfig,
} from '#/config.ts';
import { EnvVarMissing, UsageError } from '#/errors.ts';
import {
  captureInvocation,
  resolveMatcherPaths,
  selectProject,
} from '#/project-match.ts';
import {
  type SecretMissing,
  type SecretStoreError,
  Secrets,
} from '#/secrets.ts';
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

export const requireLogProvider = (
  name: string,
  config: ServiceConfig,
): Effect.Effect<LogServiceConfig, UsageError> =>
  hasLogProvider(config)
    ? Effect.succeed(config)
    : new UsageError({
        message: `${name} has no log provider; it's trace-only`,
        hint: `add a "provider" to its config entry to read logs and deploys; trace commands use its otelService "${config.otelService}"`,
      });

const VERCEL_TARGETS = ['production', 'preview'];

export const buildTarget = (
  name: string,
  config: LogServiceConfig,
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
    const config = yield* requireLogProvider(selected.name, selected.config);
    const target = yield* buildTarget(selected.name, config, flags.env);
    const source = yield* buildSource(target);
    return {
      resolved,
      name: selected.name,
      target,
      source,
    } satisfies ResolvedService;
  });

const TRACING_HINT_EXAMPLE =
  '"tracing": {"provider":"jaeger","url":"https://jaeger.example.com","headers":{"X-API-Key":{"keychain":"<name>"}}}';

const resolveHeaderValue = (
  value: HeaderValue,
): Effect.Effect<
  string,
  SecretMissing | SecretStoreError | EnvVarMissing | Config.ConfigError,
  Secrets
> => {
  if (typeof value === 'string') return Effect.succeed(value);
  if ('keychain' in value) {
    return Secrets.use((secrets) => secrets.get(value.keychain));
  }
  return Config.String(value.env).pipe(
    Config.option,
    Effect.flatMap((found) =>
      Option.isSome(found) && found.value !== ''
        ? Effect.succeed(found.value)
        : new EnvVarMissing({ name: value.env }),
    ),
  );
};

/** Reads keychain and env values only when called, so log commands never touch either. */
export const resolveHeaders = (
  headers: Readonly<Record<string, HeaderValue>> | undefined,
) =>
  Effect.forEach(
    Object.entries(headers ?? {}),
    ([name, value]) =>
      resolveHeaderValue(value).pipe(
        Effect.map((resolved) => [name, resolved] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((pairs) => Object.fromEntries(pairs)));

const noTracingConfig = (resolved: ResolvedProject) =>
  new UsageError({
    message: `project "${resolved.projectName}" has no tracing config`,
    hint: `add to the project in ${resolved.configPath}: ${TRACING_HINT_EXAMPLE}; see \`traces --help\``,
  });

export const resolveTraceBackend = (resolved: ResolvedProject) =>
  Effect.gen(function* () {
    const tracing = resolved.project.tracing;
    if (tracing === undefined) {
      return yield* noTracingConfig(resolved);
    }
    const headers = yield* resolveHeaders(tracing.headers);
    return yield* makeJaegerBackend({ url: tracing.url, headers });
  });

/** Like `resolveService` for trace commands: the service needs no log provider, only an otelService. */
export const resolveTraceService = (
  flags: GlobalFlags,
  service: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(flags);
    const selected = yield* selectService(resolved, service);
    const backend = yield* resolveTraceBackend(resolved);
    return {
      resolved,
      name: selected.name,
      otelService: otelServiceName(selected.name, selected.config),
      backend,
    };
  });

export type ErrorSource = 'logs' | 'traces';

const buildLogService = (
  name: string,
  config: LogServiceConfig,
  env: GlobalFlags['env'],
) =>
  Effect.gen(function* () {
    const target = yield* buildTarget(name, config, env);
    const source = yield* buildSource(target);
    return { target, source };
  });

type LogBuild = ReturnType<typeof buildLogService>;

/**
 * Which services `errors` reads, per side. Without `--source` both sides run, the
 * trace side only when the project has `tracing`. A trace-only service takes part in the
 * trace side; naming one when no trace side will run fails like `resolveService`. Each log
 * entry's `build` is deferred so one service's missing token or bad target fails alone
 * instead of aborting the others; the trace backend is resolved once, lazily, because it
 * reads the keychain.
 */
export const resolveErrorScope = (
  flags: GlobalFlags,
  requested: Option.Option<string>,
  sourceFlag: Option.Option<ErrorSource>,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(flags);
    const wantLogs = Option.isNone(sourceFlag) || sourceFlag.value === 'logs';
    const wantTraces =
      Option.isNone(sourceFlag) || sourceFlag.value === 'traces';
    if (
      Option.isSome(sourceFlag) &&
      sourceFlag.value === 'traces' &&
      resolved.project.tracing === undefined
    ) {
      return yield* noTracingConfig(resolved);
    }
    const traceSide = wantTraces && resolved.project.tracing !== undefined;

    const candidates: Array<{ name: string; config: ServiceConfig }> =
      Option.isSome(requested)
        ? [yield* selectService(resolved, requested)]
        : Object.entries(resolved.project.services).map(([name, config]) => ({
            name,
            config,
          }));
    if (Option.isSome(requested) && !traceSide) {
      const only = candidates[0];
      if (only !== undefined) yield* requireLogProvider(only.name, only.config);
    }

    const traceServices: Array<{
      name: string;
      otelService: string;
      build: LogBuild | undefined;
    }> = [];
    const logCandidates = candidates.flatMap((candidate) =>
      hasLogProvider(candidate.config)
        ? [{ name: candidate.name, config: candidate.config }]
        : [],
    );
    // Built once per service: the trace side reuses the log side's source to find the deploy `--since deploy` anchors on.
    const builds = new Map<string, LogBuild>();
    for (const selected of logCandidates) {
      builds.set(
        selected.name,
        yield* Effect.cached(
          buildLogService(selected.name, selected.config, flags.env),
        ),
      );
    }
    if (traceSide) {
      for (const candidate of candidates) {
        const otelService = otelServiceName(candidate.name, candidate.config);
        if (traceServices.some((known) => known.otelService === otelService)) {
          continue;
        }
        traceServices.push({
          name: candidate.name,
          otelService,
          build: builds.get(candidate.name),
        });
      }
    }
    const logEntries = wantLogs
      ? logCandidates.flatMap((selected) => {
          const build = builds.get(selected.name);
          return build === undefined ? [] : [{ name: selected.name, build }];
        })
      : [];
    if (logEntries.length === 0 && traceServices.length === 0) {
      return yield* new UsageError({
        message: `project "${resolved.projectName}" has no log services; all are trace-only`,
        hint: 'add a "provider" to a service entry in the config to read its logs, or a "tracing" block to read its traces',
      });
    }

    const traceBackend =
      traceServices.length === 0
        ? undefined
        : yield* Effect.cached(resolveTraceBackend(resolved));
    return {
      resolved,
      entries: logEntries,
      traces:
        traceBackend === undefined
          ? undefined
          : { services: traceServices, backend: traceBackend },
    };
  });
