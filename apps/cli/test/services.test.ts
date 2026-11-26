import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Option } from 'effect';
import { keychainStatus } from '#/commands/services.ts';
import {
  groupProviders,
  type ProviderEntry,
  renderServices as renderServicesFor,
  type ServiceEntry,
  type ServicesView,
  servicesDocument,
  servicesWarnings,
  type TracingCheck,
  type TracingStatus,
} from '#/commands/services-view.ts';
import { hasLogProvider } from '#/config.ts';
import {
  type SecretFileError,
  SecretMissing,
  SecretStoreError,
  Secrets,
} from '#/secrets.ts';
import { makeStyle, type Style } from '#/style.ts';

type Answer = (response: import('node:http').ServerResponse) => void;

let server: Server;
let dir: string;
let requests = 0;
let answer: Answer = (response) => {
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ services: ['acme-web', 'jaeger'] }));
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'traces-services-'));
  server = createServer((request, response) => {
    if (request.url === '/proxy/api/v3/services') {
      requests += 1;
      answer(response);
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(() => {
  server.close();
});

const url = () =>
  `http://localhost:${(server.address() as AddressInfo).port}/proxy`;

const configFor = (tracing: unknown) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      projects: {
        app: {
          matcher: { type: 'git', repo: 'acme/app' },
          ...(tracing === undefined ? {} : { tracing }),
          services: {
            web: { otelService: 'acme-web' },
            worker: { otelService: 'acme-worker' },
          },
        },
      },
    }),
  );
  return path;
};

const run = async (
  config: string,
  args: ReadonlyArray<string> = [],
  env: Record<string, string> = {},
) => {
  requests = 0;
  const child = Bun.spawn(
    [
      'bun',
      'src/main.ts',
      'services',
      '--project',
      'app',
      '--config',
      config,
      ...args,
    ],
    {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const document = (stdout: string) =>
  JSON.parse(stdout) as {
    readonly services: ReadonlyArray<Record<string, unknown>>;
    readonly providers: ReadonlyArray<unknown>;
  } & Record<string, unknown>;

const tracing = (headers?: unknown) => ({
  provider: 'jaeger',
  url: url(),
  ...(headers === undefined ? {} : { headers }),
});

describe('traces services tracing check', () => {
  test('--json is one document on one line', async () => {
    const result = await run(configFor(tracing()), ['--json']);
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.trimEnd()).not.toContain('\n');
    const doc = document(result.stdout);
    expect(Object.keys(doc)).toEqual([
      'configPath',
      'configSource',
      'project',
      'matchedBy',
      'services',
      'providers',
      'tracing',
      'warnings',
    ]);
    expect(doc.warnings).toEqual([]);
    expect(doc).toMatchObject({
      configSource: 'flag',
      project: 'app',
      matchedBy: 'flag',
    });
    expect(doc.services.map((entry) => entry.service)).toEqual([
      'web',
      'worker',
    ]);
    expect(doc.providers).toEqual([]);
    for (const entry of doc.services) {
      expect(entry).not.toHaveProperty('configPath');
      expect(entry).not.toHaveProperty('tracing');
    }
  });

  test('reachable lists the Jaeger services and flags an otelService it does not report', async () => {
    const result = await run(configFor(tracing()), ['--json']);
    expect(result.code).toBe(0);
    expect(requests).toBe(1);
    const doc = document(result.stdout);
    const [web, worker] = doc.services;
    expect(doc.tracing).toMatchObject({
      check: { status: 'reachable', services: ['acme-web', 'jaeger'] },
    });
    expect(web?.otelInJaeger).toBe(true);
    expect(worker?.otelInJaeger).toBe(false);
  });

  test('a rejected credential reports unauthorized, exits 0 and omits otelInJaeger', async () => {
    answer = (response) => response.writeHead(401).end('no');
    const result = await run(configFor(tracing()), ['--json']);
    answer = (response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ services: ['acme-web', 'jaeger'] }));
    expect(result.code).toBe(0);
    const doc = document(result.stdout);
    expect(doc.tracing).toMatchObject({
      check: { status: 'unauthorized' },
    });
    for (const entry of doc.services) {
      expect(entry).not.toHaveProperty('otelInJaeger');
    }
  });

  test('a web page instead of the API reports the response in the error', async () => {
    answer = (response) =>
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><html><body>Welcome</body></html>');
    const result = await run(configFor(tracing()), ['--json']);
    answer = (response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ services: ['acme-web', 'jaeger'] }));
    const check = (
      document(result.stdout).tracing as { check: { detail: string } }
    ).check;
    expect(check).toMatchObject({ status: 'error' });
    expect(check.detail).toContain('HTTP 200, text/html');
    expect(check.detail).toContain('<!doctype html>');
  });

  test('a missing header secret reports an error without calling Jaeger', async () => {
    const result = await run(
      configFor(tracing({ 'X-API-Key': { env: 'TRACES_TEST_NO_SUCH_VAR' } })),
      ['--json'],
      { TRACES_TEST_NO_SUCH_VAR: '' },
    );
    expect(requests).toBe(0);
    expect(document(result.stdout).tracing).toMatchObject({
      check: {
        status: 'error',
        detail: expect.stringContaining('TRACES_TEST_NO_SUCH_VAR'),
      },
    });
  });

  test('a project without tracing makes no request and has no tracing key', async () => {
    const result = await run(configFor(undefined), ['--json']);
    expect(requests).toBe(0);
    expect(result.code).toBe(0);
    const doc = document(result.stdout);
    expect(doc).not.toHaveProperty('tracing');
    expect(doc.services).toEqual([
      expect.objectContaining({
        service: 'web',
        otelService: 'acme-web',
      }),
      expect.objectContaining({
        service: 'worker',
        otelService: 'acme-worker',
      }),
    ]);
    for (const entry of doc.services) {
      expect(entry).not.toHaveProperty('otelInJaeger');
    }
  });
});

describe('traces services secrets file', () => {
  const withSecretsFile = (mode: number) => {
    const xdg = mkdtempSync(join(tmpdir(), 'traces-services-xdg-'));
    mkdirSync(join(xdg, 'traces'), { recursive: true });
    const file = join(xdg, 'traces', 'secrets.json');
    writeFileSync(file, JSON.stringify({ 'app.jaeger': 'file-token' }));
    chmodSync(file, mode);
    return { xdg, file };
  };
  const keyed = () =>
    configFor(tracing({ 'X-API-Key': { keychain: 'app.jaeger' } }));

  test('a header held by the file reads "from file" and reports the store', async () => {
    const found = withSecretsFile(0o600);
    const text = await run(keyed(), [], { XDG_CONFIG_HOME: found.xdg });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      '✓ reachable, X-API-Key from file app.jaeger',
    );
    expect(text.stdout).not.toContain('warning:');
    const json = await run(keyed(), ['--json'], {
      XDG_CONFIG_HOME: found.xdg,
    });
    const doc = document(json.stdout);
    expect(
      (doc.tracing as { headers: ReadonlyArray<unknown> }).headers,
    ).toEqual([
      {
        name: 'X-API-Key',
        source: 'keychain',
        ref: 'app.jaeger',
        status: 'present',
        store: 'file',
        shadowed: false,
      },
    ]);
    expect(doc.warnings).toEqual([]);
  });

  test('a file broader than 0600 warns with the mode and the chmod fix', async () => {
    const found = withSecretsFile(0o644);
    const text = await run(keyed(), [], { XDG_CONFIG_HOME: found.xdg });
    expect(text.stdout.trimEnd().split('\n').at(-1)).toBe(
      `warning: ${found.file} is readable by others (mode 0644); run chmod 600 ${found.file}`,
    );
    const json = await run(keyed(), ['--json'], {
      XDG_CONFIG_HOME: found.xdg,
    });
    expect(document(json.stdout).warnings).toEqual([
      {
        kind: 'file-mode',
        path: found.file,
        mode: '0644',
        message: `${found.file} is readable by others (mode 0644); run chmod 600 ${found.file}`,
      },
    ]);
  });
});

type SourceResult = Effect.Effect<
  | { readonly store: 'file'; readonly shadowed: boolean }
  | { readonly store: 'keychain'; readonly shadowed: false },
  SecretMissing | SecretStoreError | SecretFileError
>;

const fakeSecretsFor = (source: (name: string) => SourceResult) =>
  Layer.succeed(Secrets, {
    filePath: '/fake/traces/secrets.json',
    get: () => Effect.die('unused'),
    source,
    set: () => Effect.die('unused'),
    delete: () => Effect.die('unused'),
    fileStatus: Effect.succeed(Option.none()),
  });

describe('keychainStatus', () => {
  const statusFrom = (source: (name: string) => SourceResult) =>
    Effect.runPromise(
      keychainStatus('app.jaeger').pipe(Effect.provide(fakeSecretsFor(source))),
    );

  test('carries the store and shadowed flag of the secret', async () => {
    expect(
      await statusFrom(() =>
        Effect.succeed({ store: 'file', shadowed: true } as const),
      ),
    ).toEqual({ status: 'present', store: 'file', shadowed: true });
  });

  test('is missing when neither store holds it', async () => {
    expect(
      await statusFrom((name) => Effect.fail(new SecretMissing({ name }))),
    ).toEqual({ status: 'missing' });
  });

  test('flags a keychain that cannot prompt', async () => {
    const status = await statusFrom((name) =>
      Effect.fail(
        new SecretStoreError({
          operation: 'get',
          name,
          cause: new Error('User interaction is not allowed. (code: -25308)'),
        }),
      ),
    );
    expect(status).toEqual({
      status: 'error',
      detail: 'User interaction is not allowed. (code: -25308)',
      cantPrompt: true,
    });
  });

  test('does not flag another keychain failure', async () => {
    const status = await statusFrom((name) =>
      Effect.fail(
        new SecretStoreError({
          operation: 'get',
          name,
          cause: new Error('keychain exploded'),
        }),
      ),
    );
    expect(status).toMatchObject({ status: 'error', cantPrompt: false });
  });
});

const PROJECT_ID = 'df361d61-2d2a-4838-9295-cd227871305b';
const plain = makeStyle(false);

const renderServices = (view: ServicesView, style: Style) =>
  renderServicesFor(view, style, true);

const railwayRecord = (
  service: string,
  otelService?: string,
): ServiceEntry => ({
  service,
  provider: 'railway',
  ref: {
    provider: 'railway',
    project: PROJECT_ID,
    service: `${service}-id`,
    ...(otelService === undefined ? {} : { otelService }),
  },
});

const traceOnlyRecord = (service: string): ServiceEntry => ({
  service,
  ref: { otelService: service },
});

const railwayProvider = (auth: ProviderEntry['auth']): ProviderEntry => ({
  provider: 'railway',
  scope: `project ${PROJECT_ID}`,
  auth,
});

const keychainAuth = {
  status: 'ok',
  detail: 'token from keychain acme.railway',
} as const;

const jaeger = (
  check: TracingCheck,
  headers: TracingStatus['headers'] = [],
): TracingStatus => ({
  provider: 'jaeger',
  url: 'https://jaeger.example',
  headers,
  check,
});

const apiKey = {
  name: 'X-API-Key',
  source: 'keychain',
  ref: 'acme.jaeger',
  status: 'present',
  store: 'keychain',
  shadowed: false,
} as const;

const viewOf = (
  services: ReadonlyArray<ServiceEntry>,
  tracing?: TracingStatus,
  providers: ReadonlyArray<ProviderEntry> = [railwayProvider(keychainAuth)],
): ServicesView => ({
  project: 'acme',
  configPath: '/home/me/.config/traces/config.json',
  configSource: 'global',
  matchedBy: 'flag',
  home: '/home/me',
  ...(tracing === undefined ? {} : { tracing }),
  services,
  providers,
  warnings: [],
});

const vercelRecord = (project: string, team?: string): ServiceEntry => ({
  service: project,
  provider: 'vercel',
  ref: {
    provider: 'vercel',
    project,
    ...(team === undefined ? {} : { team }),
  },
});

const mixedServices = [
  railwayRecord('engine'),
  railwayRecord('worker'),
  vercelRecord('site-a', 'acme'),
  vercelRecord('site-b', 'acme'),
  vercelRecord('solo'),
  traceOnlyRecord('api'),
];

const authChecksOf = (services: ReadonlyArray<ServiceEntry>) =>
  services.flatMap((entry) =>
    hasLogProvider(entry.ref) ? [{ ref: entry.ref, auth: keychainAuth }] : [],
  );

describe('groupProviders', () => {
  test('groups by Railway project and Vercel team or project, in first-seen order', () => {
    expect(groupProviders(authChecksOf(mixedServices))).toEqual([
      {
        provider: 'railway',
        scope: `project ${PROJECT_ID}`,
        auth: keychainAuth,
      },
      { provider: 'vercel', scope: 'team acme', auth: keychainAuth },
      { provider: 'vercel', scope: 'project solo', auth: keychainAuth },
    ]);
  });

  test('trace-only services contribute nothing', () => {
    expect(groupProviders(authChecksOf([traceOnlyRecord('api')]))).toEqual([]);
  });
});

describe('servicesWarnings', () => {
  const file = (mode: number) =>
    Option.some({ path: '/home/me/.config/traces/secrets.json', mode });
  const input = {
    secretsFile: '/home/me/.config/traces/secrets.json',
    fileStatus: Option.none<{ path: string; mode: number }>(),
    headers: [] as ReadonlyArray<TracingStatus['headers'][number]>,
    providers: [] as ReadonlyArray<ProviderEntry>,
  };

  test('0600 and a missing file are quiet', () => {
    expect(servicesWarnings({ ...input, fileStatus: file(0o600) })).toEqual([]);
    expect(servicesWarnings({ ...input, fileStatus: file(0o400) })).toEqual([]);
    expect(servicesWarnings(input)).toEqual([]);
  });

  test.each([
    [0o644, '0644'],
    [0o660, '0660'],
    [0o604, '0604'],
  ])('mode %o warns that the file is readable by others', (mode, shown) => {
    expect(servicesWarnings({ ...input, fileStatus: file(mode) })).toEqual([
      {
        kind: 'file-mode',
        path: '/home/me/.config/traces/secrets.json',
        mode: shown,
        message: `/home/me/.config/traces/secrets.json is readable by others (mode ${shown}); run chmod 600 /home/me/.config/traces/secrets.json`,
      },
    ]);
  });

  test('warns once per secret that is in both the file and the keychain', () => {
    const warnings = servicesWarnings({
      ...input,
      headers: [
        { ...apiKey, store: 'file', shadowed: true },
        { ...apiKey, name: 'X-Other', store: 'file', shadowed: false },
      ],
      providers: [
        railwayProvider({
          ...keychainAuth,
          shadowedSecret: 'mockingbird.railway',
        }),
        railwayProvider({
          ...keychainAuth,
          shadowedSecret: 'mockingbird.railway',
        }),
      ],
    });
    expect(warnings).toEqual([
      {
        kind: 'shadowed',
        name: 'mockingbird.jaeger',
        path: '/home/me/.config/traces/secrets.json',
        message:
          'secret "mockingbird.jaeger" is in both /home/me/.config/traces/secrets.json and the keychain; the file wins',
      },
      {
        kind: 'shadowed',
        name: 'mockingbird.railway',
        path: '/home/me/.config/traces/secrets.json',
        message:
          'secret "mockingbird.railway" is in both /home/me/.config/traces/secrets.json and the keychain; the file wins',
      },
    ]);
  });
});

describe('servicesDocument', () => {
  test('is the config identity, services, providers and tracing in that order', () => {
    const tracingStatus = jaeger({ status: 'reachable', services: ['engine'] });
    const doc = servicesDocument(
      viewOf([railwayRecord('engine')], tracingStatus),
    );
    expect(Object.keys(doc)).toEqual([
      'configPath',
      'configSource',
      'project',
      'matchedBy',
      'services',
      'providers',
      'tracing',
      'warnings',
    ]);
    expect(doc.warnings).toEqual([]);
    expect(doc.providers).toEqual([railwayProvider(keychainAuth)]);
    expect(doc.tracing).toBe(tracingStatus);
    expect(doc).not.toHaveProperty('home');
  });

  test('has no tracing key without tracing', () => {
    expect(
      servicesDocument(viewOf([railwayRecord('engine')])),
    ).not.toHaveProperty('tracing');
  });
});

describe('renderServices', () => {
  const servicesTable = (output: string): string => {
    const section = output.split('\n\n')[1];
    if (section === undefined) throw new Error('no Services section');
    return section;
  };

  test('lays out the header, a Services table and the Providers', () => {
    const output = renderServices(
      viewOf(
        [
          railwayRecord('engine'),
          railwayRecord('web', 'acme-web'),
          railwayRecord('worker', 'acme-worker'),
          traceOnlyRecord('api'),
        ],
        jaeger(
          {
            status: 'reachable',
            services: ['engine', 'acme-web', 'api', 'jaeger', 'panel'],
          },
          [apiKey],
        ),
      ),
      plain,
    );
    expect(output).toBe(
      [
        'acme  ~/.config/traces/config.json (global, picked by --project)',
        '',
        'Services',
        '  SERVICE  PROVIDER  ENV         TRACES',
        '  engine   railway   production  ✓',
        '  web      railway   production  ✓ acme-web',
        '  worker   railway   production  – no spans',
        '  api      traces only           ✓',
        '',
        'Providers',
        `  railway  project ${PROJECT_ID}  ✓ token from keychain acme.railway`,
        '  jaeger   https://jaeger.example                        ✓ reachable, X-API-Key from keychain acme.jaeger',
        '           also reporting, not in config: jaeger, panel',
      ].join('\n'),
    );
    expect(output).not.toContain('→');
  });

  test('describes how the project was found', () => {
    const view = viewOf([railwayRecord('engine')]);
    const header = (override: Partial<ServicesView>) =>
      renderServices({ ...view, ...override }, plain).split('\n')[0];
    expect(header({ matchedBy: 'path' })).toContain(
      '(global, matched by path)',
    );
    expect(header({ matchedBy: 'git' })).toContain(
      '(global, matched by git remote)',
    );
    expect(
      header({
        configSource: 'repo',
        matchedBy: 'repo',
        configPath: '/r/traces.json',
      }),
    ).toBe('acme  /r/traces.json (repo traces.json)');
    expect(header({ configSource: 'flag' })).toContain(
      '(--config, picked by --project)',
    );
  });

  test('shows the otel name only when it differs from the key', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine'), railwayRecord('web', 'acme-web')],
        jaeger({
          status: 'reachable',
          services: ['engine', 'acme-web'],
        }),
      ),
      plain,
    );
    expect(output).toContain('  engine   railway   production  ✓\n');
    expect(output).toContain('  web      railway   production  ✓ acme-web');
  });

  test('a service Jaeger does not report is marked no spans', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('worker', 'acme-worker')],
        jaeger({ status: 'reachable', services: ['other'] }),
      ),
      plain,
    );
    expect(output).toContain('  worker   railway   production  – no spans');
    expect(output).not.toContain('not reporting');
  });

  test('a trace-only service spans the provider and env columns', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine'), traceOnlyRecord('api')],
        jaeger({ status: 'reachable', services: ['engine', 'api'] }),
      ),
      plain,
    );
    expect(output).toContain('  api      traces only           ✓');
  });

  test('without a tracing block there is no traces column and no jaeger line', () => {
    const output = renderServices(viewOf([railwayRecord('engine')]), plain);
    expect(output).toContain('  SERVICE  PROVIDER  ENV\n');
    expect(output).toContain('  engine   railway   production\n');
    expect(output).not.toContain('TRACES');
    expect(output).not.toContain('jaeger');
  });

  test('an unreachable Jaeger drops the traces column and carries the failure on its line', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine')],
        jaeger({ status: 'error', detail: 'no answer within 5s' }),
      ),
      plain,
    );
    expect(output).toContain('  SERVICE  PROVIDER  ENV\n');
    expect(output).toContain('  engine   railway   production\n');
    expect(output).not.toContain('TRACES');
    expect(servicesTable(output)).not.toContain('✓');
    expect(output).toContain('✗ error');
    expect(output).toContain('\n           no answer within 5s');
    expect(
      renderServices(
        viewOf([railwayRecord('engine')], jaeger({ status: 'unauthorized' })),
        plain,
      ),
    ).toContain('✗ unauthorized');
  });

  test('a provider without auth shows the status and the fix on the next line', () => {
    const output = renderServices(
      viewOf([railwayRecord('engine')], undefined, [
        railwayProvider({
          status: 'missing',
          detail: 'traces secret set acme.railway',
        }),
      ]),
      plain,
    );
    expect(output).toContain(
      `  railway  project ${PROJECT_ID}  ✗ missing\n           traces secret set acme.railway`,
    );
  });

  test('one provider line per Railway project and per Vercel team or project', () => {
    const output = renderServices(
      viewOf(
        mixedServices,
        undefined,
        groupProviders(authChecksOf(mixedServices)),
      ),
      plain,
    );
    expect(output.split(`project ${PROJECT_ID}`).length).toBe(2);
    expect(output.match(/ team acme /g)?.length).toBe(1);
    expect(output).toContain('vercel   project solo');
    expect(output).toContain('  site-a   vercel\n');
  });

  test('a missing keychain header is red-flagged with a hint line', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine')],
        jaeger(
          {
            status: 'error',
            detail: 'secret "acme.jaeger" is not in the keychain',
          },
          [{ ...apiKey, status: 'missing' }],
        ),
      ),
      plain,
    );
    expect(output).toContain('✗ X-API-Key: keychain acme.jaeger missing');
    expect(output).toContain('hint: traces secret set acme.jaeger');
    expect(output).not.toContain('is not in the keychain');
  });

  test('a header held by the file reads "from file"', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine')],
        jaeger({ status: 'reachable', services: ['engine'] }, [
          { ...apiKey, store: 'file' },
        ]),
      ),
      plain,
    );
    expect(output).toContain(
      '✓ reachable, X-API-Key from file mockingbird.jaeger',
    );
    expect(output).not.toContain('X-API-Key from keychain');
  });

  test('a keychain that cannot prompt hints at --insecure-storage', () => {
    const view = (cantPrompt: boolean) =>
      viewOf(
        [railwayRecord('engine')],
        jaeger({ status: 'error', detail: 'keychain locked' }, [
          {
            ...apiKey,
            status: 'error',
            detail: 'User interaction is not allowed. (code: -25308)',
            cantPrompt,
          },
        ]),
      );
    const output = renderServices(view(true), plain);
    expect(output).toContain(
      '✗ X-API-Key: keychain mockingbird.jaeger error (User interaction is not allowed. (code: -25308))',
    );
    expect(output).toContain(
      'hint: traces secret set mockingbird.jaeger --insecure-storage',
    );
    expect(renderServices(view(false), plain)).not.toContain('hint:');
  });

  test('warnings follow the providers as `warning:` lines', () => {
    const output = renderServices(
      {
        ...viewOf([railwayRecord('engine')]),
        warnings: [
          {
            kind: 'file-mode',
            path: '/home/me/.config/traces/secrets.json',
            mode: '0644',
            message: 'first',
          },
          {
            kind: 'shadowed',
            name: 'a',
            path: '/p',
            message: 'second',
          },
        ],
      },
      plain,
    );
    expect(output.endsWith('\n\nwarning: first\nwarning: second')).toBe(true);
    expect(
      renderServices(viewOf([railwayRecord('engine')]), plain),
    ).not.toContain('warning:');
  });

  test('names each header source', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine')],
        jaeger({ status: 'reachable', services: ['engine'] }, [
          {
            name: 'X-Env',
            source: 'env',
            ref: 'JAEGER_KEY',
            status: 'present',
          },
          { name: 'X-Lit', source: 'literal' },
        ]),
      ),
      plain,
    );
    expect(output).toContain(
      '✓ reachable, X-Env from env JAEGER_KEY, X-Lit literal',
    );
  });

  test('lists Jaeger services no configured service maps to', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine')],
        jaeger({
          status: 'reachable',
          services: ['engine', 'jaeger', 'panel'],
        }),
      ),
      plain,
    );
    expect(output).toContain('also reporting, not in config: jaeger, panel');
    expect(
      renderServices(
        viewOf(
          [railwayRecord('engine')],
          jaeger({ status: 'reachable', services: ['engine'] }),
        ),
        plain,
      ),
    ).not.toContain('also reporting');
  });

  test('an empty Jaeger says nothing is reporting yet', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine')],
        jaeger({ status: 'reachable', services: [] }),
      ),
      plain,
    );
    expect(output).toContain('no services reporting yet');
    expect(output).toContain('  engine   railway   production  – no spans');
  });

  describe('the Services table', () => {
    const OTHER_PROJECT_ID = '9c1b7e20-5a44-4f0e-8a31-0d2f6b7c1e55';
    const inOtherProject = (service: string): ServiceEntry => ({
      service,
      provider: 'railway',
      ref: {
        provider: 'railway',
        project: OTHER_PROJECT_ID,
        service: `${service}-id`,
      },
    });
    test('one project: no PROJECT column, with tracing', () => {
      const output = renderServices(
        viewOf(
          [railwayRecord('engine'), railwayRecord('web', 'acme-web')],
          jaeger({
            status: 'reachable',
            services: ['engine', 'acme-web'],
          }),
        ),
        plain,
      );
      expect(servicesTable(output)).toBe(
        [
          'Services',
          '  SERVICE  PROVIDER  ENV         TRACES',
          '  engine   railway   production  ✓',
          '  web      railway   production  ✓ acme-web',
        ].join('\n'),
      );
    });

    test('one project: no PROJECT column, without tracing', () => {
      const output = renderServices(
        viewOf([railwayRecord('engine'), railwayRecord('web')]),
        plain,
      );
      expect(servicesTable(output)).toBe(
        [
          'Services',
          '  SERVICE  PROVIDER  ENV',
          '  engine   railway   production',
          '  web      railway   production',
        ].join('\n'),
      );
    });

    test('several Railway projects add a PROJECT column of 8-character prefixes after PROVIDER', () => {
      const services = [
        railwayRecord('engine'),
        inOtherProject('worker'),
        vercelRecord('site'),
        traceOnlyRecord('api'),
      ];
      const withTracing = renderServices(
        viewOf(
          services,
          jaeger({
            status: 'reachable',
            services: ['engine', 'site', 'api'],
          }),
        ),
        plain,
      );
      expect(servicesTable(withTracing)).toBe(
        [
          'Services',
          '  SERVICE  PROVIDER  PROJECT   ENV         TRACES',
          '  engine   railway   df361d61  production  ✓',
          '  worker   railway   9c1b7e20  production  – no spans',
          '  site     vercel                          ✓',
          '  api      traces only                     ✓',
        ].join('\n'),
      );
      expect(withTracing).toContain(`project ${PROJECT_ID}`);
      expect(servicesTable(renderServices(viewOf(services), plain))).toContain(
        '  SERVICE  PROVIDER  PROJECT   ENV\n',
      );
    });

    test('piped output (style off) has no ANSI codes', () => {
      const output = renderServices(
        viewOf(
          [railwayRecord('engine'), inOtherProject('worker')],
          jaeger({ status: 'reachable', services: ['engine'] }),
        ),
        plain,
      );
      expect(output).not.toContain('\u001b');
    });
  });

  describe('piped versus a terminal', () => {
    const OTHER_PROJECT_ID = '9c1b7e20-5a44-4f0e-8a31-0d2f6b7c1e55';
    const view = viewOf([
      railwayRecord('engine'),
      {
        service: 'worker',
        provider: 'railway',
        ref: {
          provider: 'railway',
          project: OTHER_PROJECT_ID,
          service: 'worker-id',
        },
      },
    ]);

    test('piped text prints full project ids and the full config path', () => {
      const output = renderServicesFor(view, plain, false);
      expect(servicesTable(output)).toBe(
        [
          'Services',
          `  SERVICE  PROVIDER  PROJECT${' '.repeat(PROJECT_ID.length - 'PROJECT'.length)}  ENV`,
          `  engine   railway   ${PROJECT_ID}  production`,
          `  worker   railway   ${OTHER_PROJECT_ID}  production`,
        ].join('\n'),
      );
      expect(output.split('\n')[0]).toBe(
        'acme  /home/me/.config/traces/config.json (global, picked by --project)',
      );
      expect(output).not.toContain('~');
    });

    test('a terminal shortens project ids to 8 characters and the home directory to ~', () => {
      const output = renderServicesFor(view, plain, true);
      expect(servicesTable(output)).toContain(
        '  engine   railway   df361d61  ',
      );
      expect(servicesTable(output)).not.toContain(PROJECT_ID);
      expect(output.split('\n')[0]).toBe(
        'acme  ~/.config/traces/config.json (global, picked by --project)',
      );
    });
  });

  test('an enabled style wraps the marks in ANSI codes', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine'), railwayRecord('worker', 'w')],
        jaeger({ status: 'reachable', services: ['engine'] }),
      ),
      makeStyle(true),
    );
    expect(output).toContain('\u001b[1macme\u001b[22m');
    expect(output).toContain('\u001b[32m✓\u001b[39m');
    expect(output).toContain('\u001b[2m– no spans\u001b[22m');
    expect(output).toContain('\u001b[2mSERVICE');
    expect(output.replace(/\u001b\[[0-9;]*m/g, '')).toBe(
      renderServices(
        viewOf(
          [railwayRecord('engine'), railwayRecord('worker', 'w')],
          jaeger({ status: 'reachable', services: ['engine'] }),
        ),
        plain,
      ),
    );
  });
});
