import { Config, Console, Effect, Option } from 'effect';
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
import { causeMessage, emitRecord, outputMode } from '#/output.ts';
import { globalOptions, resolveProject } from '#/resolve.ts';
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

interface TracingStatus {
  readonly provider: 'jaeger';
  readonly url: string;
  readonly headers: ReadonlyArray<HeaderStatus>;
}

interface ServiceRecord {
  readonly configPath: string;
  readonly project: string;
  readonly matchedBy: 'flag' | 'path' | 'git';
  readonly service: string;
  /** Absent for trace-only services. */
  readonly provider?: 'vercel' | 'railway';
  readonly ref: ServiceConfig;
  /** Absent for trace-only services. */
  readonly auth?: AuthStatus;
  /** The Jaeger service name; set only when the project has tracing or the entry names one. */
  readonly otelService?: string;
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

const tracingStatus = (tracing: TracingConfig) =>
  Effect.forEach(Object.entries(tracing.headers ?? {}), ([name, value]) =>
    headerStatus(name, value),
  ).pipe(
    Effect.map(
      (headers): TracingStatus => ({
        provider: tracing.provider,
        url: tracing.url,
        headers,
      }),
    ),
  );

const formatHeader = (header: HeaderStatus): string => {
  if (header.source === 'literal') return `${header.name}: literal`;
  const state =
    header.status === 'error' ? `error (${header.detail})` : header.status;
  return `${header.name}: ${header.source} ${header.ref} ${state}`;
};

const formatTracing = (tracing: TracingStatus): string =>
  [
    `tracing ${tracing.provider} ${tracing.url}`,
    ...tracing.headers.map((header) => `  header ${formatHeader(header)}`),
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
          : yield* tracingStatus(resolved.project.tracing);
      if (mode === 'human') {
        yield* Console.log(
          `config ${resolved.configPath}\nproject ${resolved.projectName} (matched by ${resolved.matchedBy})`,
        );
        if (tracing !== undefined) yield* Console.log(formatTracing(tracing));
      }
      const authCache = new Map<'vercel' | 'railway', AuthStatus>();
      for (const [service, ref] of Object.entries(resolved.project.services)) {
        const common = {
          configPath: resolved.configPath,
          project: resolved.projectName,
          matchedBy: resolved.matchedBy,
          service,
          ref,
          ...(tracing === undefined ? {} : { tracing }),
          ...(tracing === undefined && ref.otelService === undefined
            ? {}
            : { otelService: otelServiceName(service, ref) }),
        };
        if (!hasLogProvider(ref)) {
          yield* emitRecord(
            mode,
            common satisfies ServiceRecord,
            formatService,
          );
          continue;
        }
        let auth = authCache.get(ref.provider);
        if (auth === undefined) {
          auth = yield* ref.provider === 'railway'
            ? railwayAuthStatus
            : vercelAuthStatus;
          authCache.set(ref.provider, auth);
        }
        yield* emitRecord(
          mode,
          { ...common, provider: ref.provider, auth } satisfies ServiceRecord,
          formatService,
        );
      }
    }),
);
