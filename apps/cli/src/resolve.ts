import {
  type LogSource,
  makeJaegerBackend,
  makeRailwayCliClient,
  makeRailwayHttpClient,
  makeRailwaySource,
  makeVercelSource,
  ProviderAuthError,
  railwayProjectLayout,
  type ServiceTarget,
} from '@traces/core';
import { Config, Console, Effect, Option, Redacted } from 'effect';
import { Flag } from 'effect/cli';
import {
  type HeaderValue,
  hasLogProvider,
  type LogServiceConfig,
  otelServiceName,
  type ProjectSettings,
  readConfig,
  resolveDefaultConfigPath,
  type SecretRef,
  type ServiceConfig,
} from '#/config.ts';
import { EnvVarMissing, UsageError } from '#/errors.ts';
import {
  captureInvocation,
  resolveMatcherPaths,
  selectProject,
} from '#/project-match.ts';
import { findRepoConfig } from '#/repo-config.ts';
import {
  type SecretMissing,
  type SecretStoreError,
  Secrets,
} from '#/secrets.ts';
import { findVercelToken } from '#/vercel-token.ts';

export const globalOptions = {
  project: Flag.String('project').pipe(
    Flag.withDescription(
      'project from the global config; overrides cwd matching and skips the repo traces.json',
    ),
    Flag.optional,
  ),
  env: Flag.String('env').pipe(
    Flag.withDescription(
      'Railway environment name, or Vercel target (production | preview)',
    ),
    Flag.optional,
  ),
  config: Flag.String('config').pipe(
    Flag.withDescription(
      'config file (default: traces.json at the git root, else $XDG_CONFIG_HOME/traces/config.json)',
    ),
    Flag.optional,
  ),
  json: Flag.Boolean('json').pipe(
    Flag.withDescription(
      'NDJSON output even on a TTY (it is the default when piped)',
    ),
    Flag.withDefault(false),
  ),
};

export interface GlobalFlags {
  readonly project: Option.Option<string>;
  readonly env: Option.Option<string>;
  readonly config: Option.Option<string>;
  readonly json: boolean;
}

export type ConfigSource = 'flag' | 'repo' | 'global';

export interface ResolvedProject {
  readonly configPath: string;
  readonly configSource: ConfigSource;
  readonly projectName: string;
  readonly matchedBy: 'flag' | 'path' | 'git' | 'repo';
  readonly project: ProjectSettings;
}

const resolveFromFile = (
  flags: GlobalFlags,
  configPath: string,
  configSource: 'flag' | 'global',
) =>
  Effect.gen(function* () {
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
      configSource,
      projectName: selected.name,
      matchedBy: selected.matchedBy,
      project: selected.project,
    } satisfies ResolvedProject;
  });

/** `--config` wins, then the repo's `traces.json`, then the global file; `--project` names live in the global file, so it skips the repo one. */
export const resolveProject = (flags: GlobalFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.config)) {
      return yield* resolveFromFile(flags, flags.config.value, 'flag');
    }
    if (Option.isNone(flags.project)) {
      const repo = yield* findRepoConfig(process.cwd());
      if (Option.isSome(repo)) {
        return {
          configPath: repo.value.path,
          configSource: 'repo',
          projectName: repo.value.name,
          matchedBy: 'repo',
          project: repo.value.project,
        } satisfies ResolvedProject;
      }
    }
    return yield* resolveFromFile(
      flags,
      yield* resolveDefaultConfigPath,
      'global',
    );
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

type RailwayServiceConfig = Extract<ServiceConfig, { provider: 'railway' }>;

const railwayServices = (resolved: ResolvedProject) =>
  Object.values(resolved.project.services).filter(
    (config): config is RailwayServiceConfig =>
      'provider' in config && config.provider === 'railway',
  );

/** The names are a hint only, so a Railway failure (logged out, offline) just leaves them out. */
const railwayServiceNames = (resolved: ResolvedProject, project: string) =>
  resolveRailwayClient(resolved).pipe(
    Effect.flatMap((client) => railwayProjectLayout(client, project)),
    Effect.map((layout) => layout.services.map((service) => service.name)),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );

/**
 * `logs`, `deploys` and `errors <service>` accept a Railway service the config doesn't list, as
 * long as the config's Railway services all sit in one Railway project and environment, so the
 * name can only mean a service of that project. A name that's not there fails later in the
 * source's own by-id-or-name lookup, which lists the project's services.
 */
export const selectLogService = (
  resolved: ResolvedProject,
  requested: Option.Option<string>,
) =>
  Effect.gen(function* () {
    if (Option.isNone(requested))
      return yield* selectService(resolved, requested);
    const name = requested.value;
    const configured = resolved.project.services[name];
    if (configured !== undefined) return { name, config: configured };

    const railway = railwayServices(resolved);
    const projects = new Set(railway.map((config) => config.project));
    const environments = new Set(
      railway.map((config) => config.environment ?? 'production'),
    );
    const first = railway[0];
    if (first === undefined || projects.size !== 1 || environments.size !== 1) {
      const available = `available services in "${resolved.projectName}": ${Object.keys(resolved.project.services).join(', ')}`;
      const live =
        first !== undefined && projects.size === 1
          ? yield* railwayServiceNames(resolved, first.project)
          : undefined;
      return yield* new UsageError({
        message: `no service named "${name}" in project "${resolved.projectName}"`,
        hint:
          first === undefined || live === undefined
            ? available
            : `${available}; Railway project ${first.project} has: ${live.join(', ')}`,
      });
    }
    const project = first.project;
    yield* Console.error(
      `${name} is not in the config; using Railway service "${name}" in project ${project}. Add it (or run traces init).`,
    );
    const config: RailwayServiceConfig = {
      provider: 'railway',
      project,
      service: name,
      ...(first.environment === undefined
        ? {}
        : { environment: first.environment }),
    };
    return { name, config };
  });

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

export const missingRailwayAuth = (resolved: ResolvedProject) =>
  new ProviderAuthError({
    provider: 'railway',
    hint: `project "${resolved.projectName}" has Railway services but no railway.auth; either add "railway": { "auth": { "keychain": "${resolved.projectName}.railway" } } to the project config and run traces secret set ${resolved.projectName}.railway (a token; recommended for agents), or add "railway": { "auth": "cli" } to use the logged-in railway CLI`,
  });

/** The one place that picks the transport: a token goes over HTTP, `cli` shells out to `railway`. */
export const resolveRailwayClient = (resolved: ResolvedProject) =>
  Effect.gen(function* () {
    const auth = resolved.project.railway?.auth;
    if (auth === undefined) return yield* missingRailwayAuth(resolved);
    if (auth === 'cli') return yield* makeRailwayCliClient;
    return yield* makeRailwayHttpClient(
      Redacted.make(yield* resolveSecretRef(auth)),
    );
  });

/** `railwayClient` is passed in so one command run reads the secret once, however many Railway services it builds. */
export const buildSource = (
  target: ServiceTarget,
  railwayClient: ReturnType<typeof resolveRailwayClient>,
) =>
  target.provider === 'railway'
    ? railwayClient.pipe(
        Effect.flatMap((client) => makeRailwaySource(target, client)),
      )
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
    const selected = yield* selectLogService(resolved, service);
    const config = yield* requireLogProvider(selected.name, selected.config);
    const target = yield* buildTarget(selected.name, config, flags.env);
    const source = yield* buildSource(target, resolveRailwayClient(resolved));
    return {
      resolved,
      name: selected.name,
      target,
      source,
    } satisfies ResolvedService;
  });

const TRACING_HINT_EXAMPLE =
  '"tracing": {"provider":"jaeger","url":"https://jaeger.example.com","headers":{"X-API-Key":{"keychain":"<name>"}}}';

export const resolveSecretRef = (
  ref: SecretRef,
): Effect.Effect<
  string,
  SecretMissing | SecretStoreError | EnvVarMissing | Config.ConfigError,
  Secrets
> => {
  if ('keychain' in ref) {
    return Secrets.use((secrets) => secrets.get(ref.keychain));
  }
  return Config.String(ref.env).pipe(
    Config.option,
    Effect.flatMap((found) =>
      Option.isSome(found) && found.value !== ''
        ? Effect.succeed(found.value)
        : new EnvVarMissing({ name: ref.env }),
    ),
  );
};

const resolveHeaderValue = (value: HeaderValue) =>
  typeof value === 'string' ? Effect.succeed(value) : resolveSecretRef(value);

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
    hint: `add to ${resolved.configSource === 'repo' ? 'the top level of' : 'the project in'} ${resolved.configPath}: ${TRACING_HINT_EXAMPLE}; see \`traces skills get core --file references/tracing.md\``,
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
  railwayClient: ReturnType<typeof resolveRailwayClient>,
) =>
  Effect.gen(function* () {
    const target = yield* buildTarget(name, config, env);
    const source = yield* buildSource(target, railwayClient);
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
        ? [yield* selectLogService(resolved, requested)]
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
    const railwayClient = yield* Effect.cached(resolveRailwayClient(resolved));
    const builds = new Map<string, LogBuild>();
    for (const selected of logCandidates) {
      builds.set(
        selected.name,
        yield* Effect.cached(
          buildLogService(
            selected.name,
            selected.config,
            flags.env,
            railwayClient,
          ),
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
