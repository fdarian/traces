import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { TraceBackendUnauthorized } from '@traces/core';
import { ConfigProvider, Effect, Layer, Option, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { layerTest } from 'effect/Stdio';
import { parseSecretValue, readSecretValue } from '#/commands/secret.ts';
import { EnvVarMissing, UsageError } from '#/errors.ts';
import { EXIT_CODES, renderError } from '#/output.ts';
import {
  type ResolvedProject,
  requireLogProvider,
  resolveErrorScope,
  resolveHeaders,
  resolveTraceBackend,
} from '#/resolve.ts';
import { SecretMissing, SecretStoreError, Secrets } from '#/secrets.ts';

const fakeSecrets = (entries: Record<string, string>) => {
  const reads: Array<string> = [];
  const stored = new Map(Object.entries(entries));
  const layer = Layer.succeed(Secrets, {
    get: (name: string) => {
      reads.push(name);
      const value = stored.get(name);
      return value === undefined
        ? Effect.fail(new SecretMissing({ name }))
        : Effect.succeed(value);
    },
    set: (name: string, value: string) =>
      Effect.sync(() => void stored.set(name, value)),
    delete: (name: string) => Effect.sync(() => stored.delete(name)),
  });
  return { layer, reads, stored };
};

const env = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values));

describe('resolveHeaders', () => {
  test('resolves literal, env and keychain values', async () => {
    const secrets = fakeSecrets({ 'app.jaeger': 'kc-token' });
    const headers = await Effect.runPromise(
      resolveHeaders({
        'X-Literal': 'abc',
        'X-Env': { env: 'JAEGER_TOKEN' },
        'X-API-Key': { keychain: 'app.jaeger' },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(secrets.layer, env({ JAEGER_TOKEN: 'env-token' })),
        ),
      ),
    );
    expect(headers).toEqual({
      'X-Literal': 'abc',
      'X-Env': 'env-token',
      'X-API-Key': 'kc-token',
    });
  });

  test('never touches the keychain without a keychain reference', async () => {
    const secrets = fakeSecrets({});
    await Effect.runPromise(
      resolveHeaders({ 'X-Literal': 'abc' }).pipe(
        Effect.provide(secrets.layer),
      ),
    );
    await Effect.runPromise(
      resolveHeaders(undefined).pipe(Effect.provide(secrets.layer)),
    );
    expect(secrets.reads).toEqual([]);
  });

  test('a missing keychain entry fails as SecretMissing with the name', async () => {
    const secrets = fakeSecrets({});
    const result = await Effect.runPromise(
      resolveHeaders({ 'X-API-Key': { keychain: 'app.jaeger' } }).pipe(
        Effect.provide(secrets.layer),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(SecretMissing);
      const rendered = renderError(result.failure);
      expect(rendered.code).toBe(EXIT_CODES.auth);
      expect(rendered.hint).toBe('traces secret set app.jaeger');
    }
  });

  test.each([
    ['unset', {}],
    ['empty', { JAEGER_TOKEN: '' }],
  ])('an %s env var fails as EnvVarMissing', async (_label, values) => {
    const result = await Effect.runPromise(
      resolveHeaders({ 'X-Env': { env: 'JAEGER_TOKEN' } }).pipe(
        Effect.provide(Layer.mergeAll(fakeSecrets({}).layer, env(values))),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(EnvVarMissing);
      const rendered = renderError(result.failure);
      expect(rendered.code).toBe(EXIT_CODES.auth);
      expect(rendered.hint).toContain('JAEGER_TOKEN');
    }
  });
});

const resolvedProject = (
  tracing: ResolvedProject['project']['tracing'],
): ResolvedProject => ({
  configPath: '/cfg.json',
  projectName: 'app',
  matchedBy: 'flag',
  project: {
    matcher: { type: 'git', repo: 'acme/app' },
    tracing,
    services: { web: { provider: 'vercel', project: 'p' } },
  },
});

describe('resolveTraceBackend', () => {
  test('a project without tracing is a usage error naming the project and config', async () => {
    const result = await Effect.runPromise(
      resolveTraceBackend(resolvedProject(undefined)).pipe(
        Effect.provide(
          Layer.mergeAll(fakeSecrets({}).layer, FetchHttpClient.layer),
        ),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(UsageError);
      const rendered = renderError(result.failure);
      expect(rendered.code).toBe(EXIT_CODES.usage);
      expect(rendered.message).toContain('"app"');
      expect(rendered.hint).toContain('"tracing"');
      expect(rendered.hint).toContain('/cfg.json');
    }
  });

  test('a missing header secret fails before any request', async () => {
    const result = await Effect.runPromise(
      resolveTraceBackend(
        resolvedProject({
          provider: 'jaeger',
          url: 'https://j.example.com',
          headers: { 'X-API-Key': { keychain: 'app.jaeger' } },
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(fakeSecrets({}).layer, FetchHttpClient.layer),
        ),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(SecretMissing);
    }
  });

  test('builds a backend when every header resolves', async () => {
    const backend = await Effect.runPromise(
      resolveTraceBackend(
        resolvedProject({
          provider: 'jaeger',
          url: 'https://j.example.com/~/jaeger',
          headers: { 'X-API-Key': { keychain: 'app.jaeger' } },
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            fakeSecrets({ 'app.jaeger': 'tok' }).layer,
            FetchHttpClient.layer,
          ),
        ),
      ),
    );
    expect(typeof backend.searchTraces).toBe('function');
  });
});

describe('error rendering', () => {
  test('TraceBackendUnauthorized exits 3 with a hint about the header secret', () => {
    const rendered = renderError(
      new TraceBackendUnauthorized({
        status: 401,
        url: 'https://j.example.com',
      }),
    );
    expect(rendered.code).toBe(EXIT_CODES.auth);
    expect(rendered.message).toContain('401');
    expect(rendered.hint).toContain('traces secret set');
  });

  test('a keychain store failure is a runtime error that names the operation and cause', () => {
    const rendered = renderError(
      new SecretStoreError({
        operation: 'get',
        name: 'app.jaeger',
        cause: new Error('keychain is locked'),
      }),
    );
    expect(rendered.code).toBe(EXIT_CODES.runtime);
    expect(rendered.message).toContain('get');
    expect(rendered.message).toContain('keychain is locked');
  });
});

describe('trace-only services', () => {
  const traceOnly = { otelService: 'x-data' } as const;

  test('are rejected for logs with the plan wording and exit 2', async () => {
    const result = await Effect.runPromise(
      requireLogProvider('x', traceOnly).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      const rendered = renderError(result.failure);
      expect(rendered.message).toBe("x has no log provider; it's trace-only");
      expect(rendered.code).toBe(EXIT_CODES.usage);
    }
  });

  const configFile = (services: Record<string, unknown>, tracing = true) => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-cli-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        projects: {
          app: {
            matcher: { type: 'git', repo: 'acme/app' },
            ...(tracing
              ? {
                  tracing: { provider: 'jaeger', url: 'https://j.example.com' },
                }
              : {}),
            services,
          },
        },
      }),
    );
    return path;
  };

  const flags = (config: string) => ({
    project: Option.some('app'),
    env: Option.none<string>(),
    config: Option.some(config),
    json: true,
  });

  const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(effect.pipe(Effect.result));

  const services = {
    web: { provider: 'vercel', project: 'p' },
    x: { otelService: 'x-data' },
  };

  const scope = (
    config: string,
    service: Option.Option<string>,
    source: Option.Option<'logs' | 'traces'>,
  ) =>
    run(
      resolveErrorScope(flags(config), service, source).pipe(
        Effect.provide(BunServices.layer),
      ),
    );

  const logNames = (result: Awaited<ReturnType<typeof scope>>) =>
    result._tag === 'Success' ? result.success.entries.map((e) => e.name) : [];
  const traceNames = (result: Awaited<ReturnType<typeof scope>>) =>
    result._tag === 'Success'
      ? (result.success.traces?.services.map((s) => s.name) ?? [])
      : [];

  test('errors across all services reads logs from log services and traces from every service', async () => {
    const result = await scope(
      configFile(services),
      Option.none(),
      Option.none(),
    );
    expect(logNames(result)).toEqual(['web']);
    expect(traceNames(result)).toEqual(['web', 'x']);
  });

  test('without tracing, a trace-only service is skipped for logs and there is no trace side', async () => {
    const result = await scope(
      configFile(services, false),
      Option.none(),
      Option.none(),
    );
    expect(logNames(result)).toEqual(['web']);
    expect(traceNames(result)).toEqual([]);
  });

  test('--source logs skips the trace side, --source traces the log side', async () => {
    const config = configFile(services);
    const logs = await scope(config, Option.none(), Option.some('logs'));
    expect(logNames(logs)).toEqual(['web']);
    expect(traceNames(logs)).toEqual([]);
    const traces = await scope(config, Option.none(), Option.some('traces'));
    expect(logNames(traces)).toEqual([]);
    expect(traceNames(traces)).toEqual(['web', 'x']);
  });

  test('naming a trace-only service works when tracing covers it', async () => {
    const result = await scope(
      configFile(services),
      Option.some('x'),
      Option.none(),
    );
    expect(logNames(result)).toEqual([]);
    expect(traceNames(result)).toEqual(['x']);
  });

  test.each([
    ['no tracing config', false, Option.none<'logs' | 'traces'>()],
    ['--source logs', true, Option.some<'logs' | 'traces'>('logs')],
  ])('naming a trace-only service is a usage error with %s', async (_label, tracing, source) => {
    const result = await scope(
      configFile(services, tracing),
      Option.some('x'),
      source,
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(renderError(result.failure).code).toBe(EXIT_CODES.usage);
    }
  });

  test('--source traces without a tracing block exits 2 with the config hint', async () => {
    const result = await scope(
      configFile(services, false),
      Option.none(),
      Option.some('traces'),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      const rendered = renderError(result.failure);
      expect(rendered.code).toBe(EXIT_CODES.usage);
      expect(rendered.message).toContain('no tracing config');
    }
  });

  test('only trace-only services: the trace side covers them, but with no tracing there is nothing to read', async () => {
    const onlyTraceOnly = { x: { otelService: 'x-data' } };
    const covered = await scope(
      configFile(onlyTraceOnly),
      Option.none(),
      Option.none(),
    );
    expect(logNames(covered)).toEqual([]);
    expect(traceNames(covered)).toEqual(['x']);
    const bare = await scope(
      configFile(onlyTraceOnly, false),
      Option.none(),
      Option.none(),
    );
    expect(bare._tag).toBe('Failure');
    if (bare._tag === 'Failure') {
      expect(renderError(bare.failure).code).toBe(EXIT_CODES.usage);
    }
  });

  test('two services on one otelService are scanned once', async () => {
    const result = await scope(
      configFile({
        a: { otelService: 'same' },
        b: { otelService: 'same' },
      }),
      Option.none(),
      Option.none(),
    );
    expect(traceNames(result)).toEqual(['a']);
  });
});

describe('secret set input', () => {
  test.each([
    ['tok\n', 'tok'],
    ['tok\r\n', 'tok'],
    ['tok', 'tok'],
    ['tok\n\n', 'tok\n'],
    ['  tok  \n', '  tok  '],
  ])('parseSecretValue(%p) keeps all but one trailing newline', async (raw, expected) => {
    expect(await Effect.runPromise(parseSecretValue(raw))).toBe(expected);
  });

  test.each([
    '',
    '\n',
    '\r\n',
  ])('parseSecretValue(%p) is refused', async (raw) => {
    const result = await Effect.runPromise(
      parseSecretValue(raw).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(renderError(result.failure).code).toBe(EXIT_CODES.usage);
    }
  });

  const piped = (text: string) =>
    layerTest({
      stdin: Stream.make(new TextEncoder().encode(text)),
    });

  test('reads the value from stdin when it is not a terminal, trimming one newline', async () => {
    const value = await Effect.runPromise(
      readSecretValue('app.jaeger').pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, piped('s3cret\n'))),
      ),
    );
    expect(value).toBe('s3cret');
  });

  test('an empty pipe is refused', async () => {
    const result = await Effect.runPromise(
      readSecretValue('app.jaeger').pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, piped(''))),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
  });
});
