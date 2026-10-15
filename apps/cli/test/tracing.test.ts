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
  resolveHeaders,
  resolveServices,
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

  const configFile = (services: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-cli-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        projects: {
          app: {
            matcher: { type: 'git', repo: 'acme/app' },
            tracing: { provider: 'jaeger', url: 'https://j.example.com' },
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

  test('errors across all services skips them instead of failing', async () => {
    const result = await run(
      resolveServices(flags(configFile(services)), Option.none()).pipe(
        Effect.provide(BunServices.layer),
      ),
    );
    expect(result._tag).toBe('Success');
    if (result._tag === 'Success') {
      expect(result.success.entries.map((entry) => entry.name)).toEqual([
        'web',
      ]);
    }
  });

  test('errors naming one is a usage error', async () => {
    const result = await run(
      resolveServices(flags(configFile(services)), Option.some('x')).pipe(
        Effect.provide(BunServices.layer),
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(renderError(result.failure).code).toBe(EXIT_CODES.usage);
    }
  });

  test('a project with only trace-only services has nothing to read logs from', async () => {
    const result = await run(
      resolveServices(
        flags(configFile({ x: { otelService: 'x-data' } })),
        Option.none(),
      ).pipe(Effect.provide(BunServices.layer)),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(renderError(result.failure).code).toBe(EXIT_CODES.usage);
    }
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
