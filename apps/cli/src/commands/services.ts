import { homedir } from 'node:os';
import { TraceBackendUnauthorized } from '@traces/core';
import { Cause, Config, Console, Effect, Option } from 'effect';
import { Command } from 'effect/cli';
import {
  type AuthStatus,
  railwayAuthStatus,
  vercelAuthStatus,
} from '#/auth-status.ts';
import {
  groupProviders,
  type HeaderStatus,
  renderServices,
  type SecretStatus,
  type ServiceEntry,
  type ServicesView,
  servicesDocument,
  servicesWarnings,
  type TracingCheck,
  type TracingStatus,
} from '#/commands/services-view.ts';
import {
  type HeaderValue,
  hasLogProvider,
  type LogServiceConfig,
  otelServiceName,
  type TracingConfig,
} from '#/config.ts';
import {
  causeMessage,
  outputMode,
  renderError,
  stdoutIsTerminal,
} from '#/output.ts';
import {
  globalOptions,
  type ResolvedProject,
  resolveProject,
  resolveTraceBackend,
} from '#/resolve.ts';
import { keychainCantPrompt, Secrets } from '#/secrets.ts';
import { stdoutStyle } from '#/style.ts';

export const keychainStatus = (
  name: string,
): Effect.Effect<SecretStatus, never, Secrets> =>
  Secrets.use((secrets) => secrets.source(name)).pipe(
    Effect.map(
      (found): SecretStatus => ({
        status: 'present',
        store: found.store,
        shadowed: found.shadowed,
      }),
    ),
    Effect.catchTags({
      SecretMissing: () => Effect.succeed<SecretStatus>({ status: 'missing' }),
      SecretStoreError: (error) =>
        Effect.succeed<SecretStatus>({
          status: 'error',
          detail: causeMessage(error.cause),
          cantPrompt: keychainCantPrompt(error),
        }),
      SecretFileError: (error) =>
        Effect.succeed<SecretStatus>({
          status: 'error',
          detail: causeMessage(error.cause),
          cantPrompt: false,
        }),
    }),
  );

const envStatus = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.map(
      (found) =>
        ({
          status:
            Option.isSome(found) && found.value !== '' ? 'present' : 'missing',
        }) as const,
    ),
  );

const headerStatus = (name: string, value: HeaderValue) => {
  if (typeof value === 'string') {
    return Effect.succeed<HeaderStatus>({ name, source: 'literal' });
  }
  if ('keychain' in value) {
    return keychainStatus(value.keychain).pipe(
      Effect.map(
        (status): HeaderStatus => ({
          name,
          source: 'keychain',
          ref: value.keychain,
          ...status,
        }),
      ),
    );
  }
  return envStatus(value.env).pipe(
    Effect.map(
      (status): HeaderStatus => ({
        name,
        source: 'env',
        ref: value.env,
        ...status,
      }),
    ),
  );
};

const CHECK_TIMEOUT_SECONDS = 5;

/** One `listServices` call, run only for a project with `tracing`; every failure becomes a status rather than aborting the command. */
const checkTracing = (resolved: ResolvedProject) =>
  resolveTraceBackend(resolved).pipe(
    Effect.flatMap((backend) =>
      backend.listServices.pipe(
        Effect.timeout(`${CHECK_TIMEOUT_SECONDS} seconds`),
      ),
    ),
    Effect.map((services): TracingCheck => ({ status: 'reachable', services })),
    Effect.catch((error) =>
      Effect.succeed<TracingCheck>(
        error instanceof TraceBackendUnauthorized
          ? { status: 'unauthorized' }
          : {
              status: 'error',
              detail: Cause.isTimeoutError(error)
                ? `no answer within ${CHECK_TIMEOUT_SECONDS}s`
                : renderError(error).message,
            },
      ),
    ),
  );

const tracingStatus = (resolved: ResolvedProject, tracing: TracingConfig) =>
  Effect.all({
    headers: Effect.forEach(
      Object.entries(tracing.headers ?? {}),
      ([name, value]) => headerStatus(name, value),
    ),
    check: checkTracing(resolved),
  }).pipe(
    Effect.map(
      (status): TracingStatus => ({
        provider: tracing.provider,
        url: tracing.url,
        headers: status.headers,
        check: status.check,
      }),
    ),
  );

export const servicesOptions = { ...globalOptions };

export const servicesCommand = Command.make(
  'services',
  servicesOptions,
  (args) =>
    Effect.gen(function* () {
      const resolved = yield* resolveProject(args);
      const mode = outputMode(args.json);
      const tracing =
        resolved.project.tracing === undefined
          ? undefined
          : yield* tracingStatus(resolved, resolved.project.tracing);
      const jaegerServices =
        tracing?.check.status === 'reachable'
          ? tracing.check.services
          : undefined;
      const inJaeger = (otelService: string) =>
        jaegerServices === undefined
          ? undefined
          : jaegerServices.includes(otelService);
      const authCache = new Map<string, AuthStatus>();
      const services: Array<ServiceEntry> = [];
      const authChecks: Array<{
        readonly ref: LogServiceConfig;
        readonly auth: AuthStatus;
      }> = [];
      for (const [service, ref] of Object.entries(resolved.project.services)) {
        const found = inJaeger(otelServiceName(service, ref));
        const entry: ServiceEntry = {
          service,
          ...(hasLogProvider(ref) ? { provider: ref.provider } : {}),
          ref,
          ...(tracing === undefined && ref.otelService === undefined
            ? {}
            : { otelService: otelServiceName(service, ref) }),
          ...(found === undefined ? {} : { otelInJaeger: found }),
        };
        services.push(entry);
        if (!hasLogProvider(ref)) continue;
        const authKey =
          ref.provider === 'railway' ? `railway:${ref.project}` : 'vercel';
        let auth = authCache.get(authKey);
        if (auth === undefined) {
          auth = yield* ref.provider === 'railway'
            ? railwayAuthStatus(resolved, ref.project)
            : vercelAuthStatus;
          authCache.set(authKey, auth);
        }
        authChecks.push({ ref, auth });
      }
      const providers = groupProviders(authChecks);
      const secrets = yield* Secrets;
      const view: ServicesView = {
        project: resolved.projectName,
        configPath: resolved.configPath,
        configSource: resolved.configSource,
        matchedBy: resolved.matchedBy,
        home: homedir(),
        services,
        providers,
        ...(tracing === undefined ? {} : { tracing }),
        warnings: servicesWarnings({
          secretsFile: secrets.filePath,
          fileStatus: yield* secrets.fileStatus,
          headers: tracing?.headers ?? [],
          providers,
        }),
      };
      yield* Console.log(
        mode === 'json'
          ? JSON.stringify(servicesDocument(view))
          : renderServices(view, stdoutStyle(), stdoutIsTerminal()),
      );
    }),
).pipe(
  Command.withShortDescription(
    'matched project, services, provider auth status',
  ),
  Command.withDescription(
    "Show the project matched for the current directory (the repo's traces.json, else the global config), its services, whether each provider is authenticated, and the tracing setup (URL, header secrets, otelService) with a live reachability check of the tracing URL.",
  ),
  Command.withExamples([
    { command: 'traces services' },
    { command: 'traces services --project myapp --json' },
  ]),
);
