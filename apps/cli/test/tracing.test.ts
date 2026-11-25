import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { type RailwayClient, TraceBackendUnauthorized } from '@traces/core';
import { ConfigProvider, Effect, Layer, Option, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http';
import { PlatformError, SystemError } from 'effect/PlatformError';
import { type ChildProcess, ChildProcessSpawner } from 'effect/process';
import { layerTest } from 'effect/Stdio';
import { railwayAuthStatus } from '#/auth-status.ts';
import { parseSecretValue, readSecretValue } from '#/commands/secret.ts';
import { EnvVarMissing, UsageError } from '#/errors.ts';
import { EXIT_CODES, renderError } from '#/output.ts';
import {
  buildSource,
  type ResolvedProject,
  requireLogProvider,
  resolveErrorScope,
  resolveHeaders,
  resolveRailwayClient,
  resolveTraceBackend,
} from '#/resolve.ts';
import { SecretMissing, SecretStoreError, Secrets } from '#/secrets.ts';

const fakeSecrets = (
  entries: Record<string, string>,
  files: {
    readonly inFile?: ReadonlyArray<string>;
    readonly shadowed?: ReadonlyArray<string>;
  } = {},
) => {
  const reads: Array<string> = [];
  const stored = new Map(Object.entries(entries));
  const layer = Layer.succeed(Secrets, {
    filePath: '/fake/traces/secrets.json',
    get: (name: string) => {
      reads.push(name);
      const value = stored.get(name);
      return value === undefined
        ? Effect.fail(new SecretMissing({ name }))
        : Effect.succeed(value);
    },
    source: (name: string) =>
      stored.has(name)
        ? Effect.succeed(
            files.inFile?.includes(name)
              ? ({
                  store: 'file',
                  shadowed: files.shadowed?.includes(name) ?? false,
                } as const)
              : ({ store: 'keychain', shadowed: false } as const),
          )
        : Effect.fail(new SecretMissing({ name })),
    set: (name: string, value: string) =>
      Effect.sync(() => void stored.set(name, value)),
    delete: (name: string) => Effect.sync(() => stored.delete(name)),
    fileStatus: Effect.succeed(Option.none()),
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
  configSource: 'flag',
  matchedBy: 'flag',
  project: {
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
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            FetchHttpClient.layer,
            fakeSecrets({}).layer,
          ),
        ),
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

const railwayProject = (
  railway: ResolvedProject['project']['railway'],
): ResolvedProject => ({
  configPath: '/cfg.json',
  configSource: 'repo',
  projectName: 'app',
  matchedBy: 'repo',
  project: {
    railway,
    services: {
      api: { provider: 'railway', project: 'proj-1', service: 'api' },
    },
  },
});

const projectReply = {
  data: { project: { services: { edges: [] }, environments: { edges: [] } } },
};

interface HttpSeen {
  readonly authorization: string | undefined;
}

const fakeRailwayHttp = (
  seen: Array<HttpSeen> = [],
  reply: { readonly status: number; readonly body: unknown } = {
    status: 200,
    body: projectReply,
  },
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      seen.push({ authorization: request.headers.authorization });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), { status: reply.status }),
        ),
      );
    }),
  );

interface CliOptions {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly missingBinary?: boolean;
}

const fakeRailwayCli = (
  seen: Array<ReadonlyArray<string>> = [],
  options: CliOptions = {},
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (options.missingBinary) {
        return Effect.fail(
          new PlatformError(
            new SystemError({
              _tag: 'NotFound',
              module: 'ChildProcess',
              method: 'spawn',
            }),
          ),
        );
      }
      seen.push(
        (command as unknown as ChildProcess.StandardCommand).args.map(String),
      );
      const handle = {
        pid: 1,
        exitCode: Effect.succeed(options.exitCode ?? 0),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { write: () => Effect.void },
        stdout: Stream.make(
          new TextEncoder().encode(
            options.stdout ?? JSON.stringify(projectReply),
          ),
        ),
        stderr: Stream.empty,
      };
      return Effect.succeed(
        handle as unknown as ChildProcessSpawner.ChildProcessHandle,
      );
    }),
  );

const probe = (client: RailwayClient) =>
  client.query(
    'project',
    'query { project }',
    { id: 'proj-1' },
    Schema.Unknown,
  );

describe('railway client resolution', () => {
  const resolveAndProbe = (
    railway: ResolvedProject['project']['railway'],
    layers: {
      readonly secrets: Layer.Layer<Secrets>;
      readonly http: Array<HttpSeen>;
      readonly cli: Array<ReadonlyArray<string>>;
      readonly environment?: Record<string, string>;
    },
  ) =>
    Effect.runPromise(
      resolveRailwayClient(railwayProject(railway)).pipe(
        Effect.flatMap(probe),
        Effect.provide(
          Layer.mergeAll(
            layers.secrets,
            fakeRailwayHttp(layers.http),
            fakeRailwayCli(layers.cli),
            env(layers.environment ?? {}),
          ),
        ),
      ),
    );

  test('a keychain ref reads the keychain once and talks HTTP with the bearer token', async () => {
    const secrets = fakeSecrets({ 'app.railway': 'rw-secret' });
    const http: Array<HttpSeen> = [];
    const cli: Array<ReadonlyArray<string>> = [];
    await resolveAndProbe(
      { auth: { keychain: 'app.railway' } },
      { secrets: secrets.layer, http, cli },
    );
    expect(secrets.reads).toEqual(['app.railway']);
    expect(http).toEqual([{ authorization: 'Bearer rw-secret' }]);
    expect(cli).toEqual([]);
  });

  test('an env ref talks HTTP with the bearer token from the environment', async () => {
    const secrets = fakeSecrets({});
    const http: Array<HttpSeen> = [];
    const cli: Array<ReadonlyArray<string>> = [];
    await resolveAndProbe(
      { auth: { env: 'RAILWAY_API_TOKEN' } },
      {
        secrets: secrets.layer,
        http,
        cli,
        environment: { RAILWAY_API_TOKEN: 'envtok' },
      },
    );
    expect(http).toEqual([{ authorization: 'Bearer envtok' }]);
    expect(secrets.reads).toEqual([]);
    expect(cli).toEqual([]);
  });

  test('"cli" shells out to `railway api`, never touching the keychain or HTTP', async () => {
    const secrets = fakeSecrets({});
    const http: Array<HttpSeen> = [];
    const cli: Array<ReadonlyArray<string>> = [];
    await resolveAndProbe(
      { auth: 'cli' },
      { secrets: secrets.layer, http, cli },
    );
    expect(cli).toHaveLength(1);
    expect(cli[0]?.slice(0, 1)).toEqual(['api']);
    expect(cli[0]).toContain('id=proj-1');
    expect(secrets.reads).toEqual([]);
    expect(http).toEqual([]);
  });

  test('a Railway service without railway.auth fails with both options and never reads the keychain', async () => {
    const secrets = fakeSecrets({});
    const resolved = railwayProject(undefined);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* buildSource(
          {
            provider: 'railway',
            service: 'api',
            project: 'proj-1',
            serviceName: 'api',
            environment: 'production',
          },
          resolveRailwayClient(resolved),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            secrets.layer,
            fakeRailwayHttp(),
            fakeRailwayCli(),
            BunServices.layer,
          ),
        ),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      const rendered = renderError(result.failure);
      expect(rendered.code).toBe(EXIT_CODES.auth);
      expect(rendered.hint).toContain(
        'has Railway services but no railway.auth',
      );
      expect(rendered.hint).toContain(
        '"railway": { "auth": { "keychain": "app.railway" } }',
      );
      expect(rendered.hint).toContain('traces secret set app.railway');
      expect(rendered.hint).toContain('"railway": { "auth": "cli" }');
    }
    expect(secrets.reads).toEqual([]);
  });
});

describe('railwayAuthStatus', () => {
  const status = (
    resolved: ResolvedProject,
    layers: {
      readonly secrets?: Layer.Layer<Secrets>;
      readonly http?: Layer.Layer<HttpClient.HttpClient>;
      readonly cli?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    },
  ) =>
    Effect.runPromise(
      railwayAuthStatus(resolved, 'proj-1').pipe(
        Effect.provide(
          Layer.mergeAll(
            layers.secrets ?? fakeSecrets({}).layer,
            layers.http ?? fakeRailwayHttp(),
            layers.cli ?? fakeRailwayCli(),
            env({}),
          ),
        ),
      ),
    );
  const configured = railwayProject({ auth: { keychain: 'app.railway' } });
  const rejected = JSON.stringify({
    data: null,
    errors: [{ message: 'Not Authorized' }],
  });

  test('is missing, naming both options, when railway.auth is not configured', async () => {
    const result = await status(railwayProject(undefined), {});
    expect(result.status).toBe('missing');
    expect(result.detail).toContain('railway.auth');
    expect(result.detail).toContain('"auth": "cli"');
  });

  test('is missing, with the secret set hint, when the secret is absent', async () => {
    const result = await status(configured, {});
    expect(result).toEqual({
      status: 'missing',
      detail: 'traces secret set app.railway',
    });
  });

  test('is missing, with the export hint, when the env var is unset', async () => {
    const result = await status(
      railwayProject({ auth: { env: 'RAILWAY_API_TOKEN' } }),
      {},
    );
    expect(result).toEqual({
      status: 'missing',
      detail: 'export RAILWAY_API_TOKEN=<value>',
    });
  });

  test('is ok when the project read succeeds with a keychain token', async () => {
    const result = await status(configured, {
      secrets: fakeSecrets({ 'app.railway': 'rw' }).layer,
    });
    expect(result).toEqual({
      status: 'ok',
      detail: 'token from keychain app.railway',
    });
  });

  test('labels a token held by the secrets file as from file', async () => {
    const result = await status(configured, {
      secrets: fakeSecrets({ 'app.railway': 'rw' }, { inFile: ['app.railway'] })
        .layer,
    });
    expect(result).toEqual({
      status: 'ok',
      detail: 'token from file app.railway',
    });
  });

  test('reports a token that is in both the file and the keychain', async () => {
    const result = await status(configured, {
      secrets: fakeSecrets(
        { 'app.railway': 'rw' },
        { inFile: ['app.railway'], shadowed: ['app.railway'] },
      ).layer,
    });
    expect(result).toEqual({
      status: 'ok',
      detail: 'token from file app.railway',
      shadowedSecret: 'app.railway',
    });
  });

  test('is invalid when Railway rejects the token', async () => {
    const result = await status(configured, {
      secrets: fakeSecrets({ 'app.railway': 'rw' }).layer,
      http: fakeRailwayHttp([], {
        status: 200,
        body: { errors: [{ message: 'Not Authorized' }] },
      }),
    });
    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('Railway rejected the token');
  });

  test('"cli" is ok when the logged-in CLI can read the project', async () => {
    const result = await status(railwayProject({ auth: 'cli' }), {});
    expect(result).toEqual({ status: 'ok', detail: 'railway CLI login' });
  });

  test('"cli" is invalid, pointing at `railway login`, when the CLI is not authorized', async () => {
    const result = await status(railwayProject({ auth: 'cli' }), {
      cli: fakeRailwayCli([], { stdout: rejected }),
    });
    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('railway CLI login');
    expect(result.detail).toContain('run `railway login`');
  });

  test('"cli" is missing, with the install hint, when the binary is absent', async () => {
    const result = await status(railwayProject({ auth: 'cli' }), {
      cli: fakeRailwayCli([], { missingBinary: true }),
    });
    expect(result.status).toBe('missing');
    expect(result.detail).toContain('install the Railway CLI');
  });
});
