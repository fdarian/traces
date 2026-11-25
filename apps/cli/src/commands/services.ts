import { TraceBackendUnauthorized } from '@traces/core';
import { Cause, Config, Console, Effect, Option } from 'effect';
import { Command } from 'effect/cli';
import {
  type AuthStatus,
  railwayAuthStatus,
  vercelAuthStatus,
} from '#/auth-status.ts';
import {
  type HeaderValue,
  hasLogProvider,
  otelServiceName,
  type ServiceConfig,
  type TracingConfig,
} from '#/config.ts';
import { causeMessage, emitRecord, outputMode, renderError } from '#/output.ts';
import {
  type ConfigSource,
  globalOptions,
  type ResolvedProject,
  resolveProject,
  resolveTraceBackend,
} from '#/resolve.ts';
import { Secrets } from '#/secrets.ts';

type SecretStatus =
  | { readonly status: 'present' | 'missing' }
  | { readonly status: 'error'; readonly detail: string };

type HeaderStatus =
  | { readonly name: string; readonly source: 'literal' }
  | ({
      readonly name: string;
      readonly source: 'env' | 'keychain';
      readonly ref: string;
    } & SecretStatus);

type TracingCheck =
  | { readonly status: 'reachable'; readonly services: ReadonlyArray<string> }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error'; readonly detail: string };

interface TracingStatus {
  readonly provider: 'jaeger';
  readonly url: string;
  readonly headers: ReadonlyArray<HeaderStatus>;
  readonly check: TracingCheck;
}

interface ServiceRecord {
  readonly configPath: string;
  readonly configSource: ConfigSource;
  readonly project: string;
  readonly matchedBy: ResolvedProject['matchedBy'];
  readonly service: string;
  /** Absent for trace-only services. */
  readonly provider?: 'vercel' | 'railway';
  readonly ref: ServiceConfig;
  /** Absent for trace-only services. */
  readonly auth?: AuthStatus;
  /** The Jaeger service name; set only when the project has tracing or the entry names one. */
  readonly otelService?: string;
  /** Set only when the tracing check reached Jaeger: whether it reports `otelService`. */
  readonly otelInJaeger?: boolean;
  readonly tracing?: TracingStatus;
}

const keychainStatus = (
  name: string,
): Effect.Effect<SecretStatus, never, Secrets> =>
  Secrets.use((secrets) => secrets.get(name)).pipe(
    Effect.map((): SecretStatus => ({ status: 'present' })),
    Effect.catchTags({
      SecretMissing: () => Effect.succeed<SecretStatus>({ status: 'missing' }),
      SecretStoreError: (error) =>
        Effect.succeed<SecretStatus>({
          status: 'error',
          detail: causeMessage(error.cause),
        }),
    }),
  );

const envStatus = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.map(
      (found): SecretStatus => ({
        status:
          Option.isSome(found) && found.value !== '' ? 'present' : 'missing',
      }),
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

const formatHeader = (header: HeaderStatus): string => {
  if (header.source === 'literal') return `${header.name}: literal`;
  const state =
    header.status === 'error' ? `error (${header.detail})` : header.status;
  return `${header.name}: ${header.source} ${header.ref} ${state}`;
};

const formatCheck = (check: TracingCheck): string => {
  if (check.status === 'reachable') {
    return `reachable (${check.services.length === 0 ? 'no services yet' : check.services.join(', ')})`;
  }
  return check.status === 'error' ? `error: ${check.detail}` : check.status;
};

export const formatTracing = (
  tracing: TracingStatus,
  missing: ReadonlyArray<{
    readonly service: string;
    readonly otelService: string;
  }>,
): string =>
  [
    `tracing ${tracing.provider} ${tracing.url}`,
    ...tracing.headers.map((header) => `  header ${formatHeader(header)}`),
    `  status ${formatCheck(tracing.check)}`,
    ...missing.map(
      (entry) => `  ${entry.service} → ${entry.otelService}: not in Jaeger`,
    ),
  ].join('\n');

const formatService = (record: ServiceRecord): string => {
  const otel =
    record.otelService === undefined ? '' : `  otel: ${record.otelService}`;
  if (
    !hasLogProvider(record.ref) ||
    record.provider === undefined ||
    record.auth === undefined
  ) {
    return `${record.service.padEnd(16)} trace-only${otel}`;
  }
  const ref =
    record.ref.provider === 'railway'
      ? `project ${record.ref.project} service ${record.ref.service} env ${record.ref.environment ?? 'production'}`
      : `project ${record.ref.project}${record.ref.team === undefined ? '' : ` team ${record.ref.team}`}`;
  return `${record.service.padEnd(16)} ${record.provider.padEnd(8)} ${ref}  auth: ${record.auth.status} (${record.auth.detail})${otel}`;
};

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
      if (mode === 'human') {
        yield* Console.log(
          `config ${resolved.configPath} (${resolved.configSource})\nproject ${resolved.projectName} (matched by ${resolved.matchedBy})`,
        );
        if (tracing !== undefined) {
          const missing = Object.entries(resolved.project.services)
            .map(([service, ref]) => ({
              service,
              otelService: otelServiceName(service, ref),
            }))
            .filter((entry) => inJaeger(entry.otelService) === false);
          yield* Console.log(formatTracing(tracing, missing));
        }
      }
      const authCache = new Map<string, AuthStatus>();
      for (const [service, ref] of Object.entries(resolved.project.services)) {
        const found = inJaeger(otelServiceName(service, ref));
        const common = {
          configPath: resolved.configPath,
          configSource: resolved.configSource,
          project: resolved.projectName,
          matchedBy: resolved.matchedBy,
          service,
          ref,
          ...(tracing === undefined ? {} : { tracing }),
          ...(tracing === undefined && ref.otelService === undefined
            ? {}
            : { otelService: otelServiceName(service, ref) }),
          ...(found === undefined ? {} : { otelInJaeger: found }),
        };
        if (!hasLogProvider(ref)) {
          yield* emitRecord(
            mode,
            common satisfies ServiceRecord,
            formatService,
          );
          continue;
        }
        const authKey =
          ref.provider === 'railway' ? `railway:${ref.project}` : 'vercel';
        let auth = authCache.get(authKey);
        if (auth === undefined) {
          auth = yield* ref.provider === 'railway'
            ? railwayAuthStatus(resolved, ref.project)
            : vercelAuthStatus;
          authCache.set(authKey, auth);
        }
        yield* emitRecord(
          mode,
          { ...common, provider: ref.provider, auth } satisfies ServiceRecord,
          formatService,
        );
      }
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
