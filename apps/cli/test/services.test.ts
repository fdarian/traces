import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  groupProviders,
  type ProviderEntry,
  renderServices,
  type ServiceEntry,
  type ServicesView,
  servicesDocument,
  type TracingCheck,
  type TracingStatus,
} from '#/commands/services-view.ts';
import { hasLogProvider } from '#/config.ts';
import { makeStyle } from '#/style.ts';

type Answer = (response: import('node:http').ServerResponse) => void;

let server: Server;
let dir: string;
let requests = 0;
let answer: Answer = (response) => {
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ services: ['mockingbird-web', 'jaeger'] }));
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
            web: { otelService: 'mockingbird-web' },
            worker: { otelService: 'mockingbird-worker' },
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
    ]);
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
      check: { status: 'reachable', services: ['mockingbird-web', 'jaeger'] },
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
        .end(JSON.stringify({ services: ['mockingbird-web', 'jaeger'] }));
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
        .end(JSON.stringify({ services: ['mockingbird-web', 'jaeger'] }));
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
        otelService: 'mockingbird-web',
      }),
      expect.objectContaining({
        service: 'worker',
        otelService: 'mockingbird-worker',
      }),
    ]);
    for (const entry of doc.services) {
      expect(entry).not.toHaveProperty('otelInJaeger');
    }
  });
});

const PROJECT_ID = 'df361d61-2d2a-4838-9295-cd227871305b';
const plain = makeStyle(false);

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
  detail: 'token from keychain mockingbird.railway',
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
  ref: 'mockingbird.jaeger',
  status: 'present',
} as const;

const viewOf = (
  services: ReadonlyArray<ServiceEntry>,
  tracing?: TracingStatus,
  providers: ReadonlyArray<ProviderEntry> = [railwayProvider(keychainAuth)],
): ServicesView => ({
  project: 'mockingbird',
  configPath: '/home/me/.config/traces/config.json',
  configSource: 'global',
  matchedBy: 'flag',
  home: '/home/me',
  ...(tracing === undefined ? {} : { tracing }),
  services,
  providers,
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
    ]);
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
  const servicesTable = (output: string): string =>
    output.split('\n\n')[1] ?? '';

  test('lays out the header, a Services table and the Providers', () => {
    const output = renderServices(
      viewOf(
        [
          railwayRecord('engine'),
          railwayRecord('web', 'mockingbird-web'),
          railwayRecord('worker', 'mockingbird-worker'),
          traceOnlyRecord('api'),
        ],
        jaeger(
          {
            status: 'reachable',
            services: ['engine', 'mockingbird-web', 'api', 'jaeger', 'panel'],
          },
          [apiKey],
        ),
      ),
      plain,
    );
    expect(output).toBe(
      [
        'mockingbird  ~/.config/traces/config.json (global, picked by --project)',
        '',
        'Services',
        '  SERVICE  PROVIDER  ENV         TRACES',
        '  engine   railway   production  ✓',
        '  web      railway   production  ✓ mockingbird-web',
        '  worker   railway   production  – no spans',
        '  api      traces only           ✓',
        '',
        'Providers',
        `  railway  project ${PROJECT_ID}  ✓ token from keychain mockingbird.railway`,
        '  jaeger   https://jaeger.example                        ✓ reachable, X-API-Key from keychain mockingbird.jaeger',
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
    ).toBe('mockingbird  /r/traces.json (repo traces.json)');
    expect(header({ configSource: 'flag' })).toContain(
      '(--config, picked by --project)',
    );
  });

  test('shows the otel name only when it differs from the key', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine'), railwayRecord('web', 'mockingbird-web')],
        jaeger({
          status: 'reachable',
          services: ['engine', 'mockingbird-web'],
        }),
      ),
      plain,
    );
    expect(output).toContain('  engine   railway   production  ✓\n');
    expect(output).toContain(
      '  web      railway   production  ✓ mockingbird-web',
    );
  });

  test('a service Jaeger does not report is marked no spans', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('worker', 'mockingbird-worker')],
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
          detail: 'traces secret set mockingbird.railway',
        }),
      ]),
      plain,
    );
    expect(output).toContain(
      `  railway  project ${PROJECT_ID}  ✗ missing\n           traces secret set mockingbird.railway`,
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
            detail: 'secret "mockingbird.jaeger" is not in the keychain',
          },
          [{ ...apiKey, status: 'missing' }],
        ),
      ),
      plain,
    );
    expect(output).toContain(
      '✗ X-API-Key: keychain mockingbird.jaeger missing',
    );
    expect(output).toContain('hint: traces secret set mockingbird.jaeger');
    expect(output).not.toContain('is not in the keychain');
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
          [railwayRecord('engine'), railwayRecord('web', 'mockingbird-web')],
          jaeger({
            status: 'reachable',
            services: ['engine', 'mockingbird-web'],
          }),
        ),
        plain,
      );
      expect(servicesTable(output)).toBe(
        [
          'Services',
          '  SERVICE  PROVIDER  ENV         TRACES',
          '  engine   railway   production  ✓',
          '  web      railway   production  ✓ mockingbird-web',
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

  test('an enabled style wraps the marks in ANSI codes', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine'), railwayRecord('worker', 'w')],
        jaeger({ status: 'reachable', services: ['engine'] }),
      ),
      makeStyle(true),
    );
    expect(output).toContain('\u001b[1mmockingbird\u001b[22m');
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
