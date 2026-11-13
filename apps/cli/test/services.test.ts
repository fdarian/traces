import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderServices,
  type ServiceRecord,
  type ServicesView,
  type TracingCheck,
  type TracingStatus,
} from '#/commands/services-view.ts';
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
  const records = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stdout, stderr, code, records };
};

const tracing = (headers?: unknown) => ({
  provider: 'jaeger',
  url: url(),
  ...(headers === undefined ? {} : { headers }),
});

describe('traces services tracing check', () => {
  test('reachable lists the Jaeger services and flags an otelService it does not report', async () => {
    const result = await run(configFor(tracing()), ['--json']);
    expect(result.code).toBe(0);
    expect(requests).toBe(1);
    const [web, worker] = result.records;
    expect(web?.tracing).toMatchObject({
      check: { status: 'reachable', services: ['mockingbird-web', 'jaeger'] },
    });
    expect(web?.otelInJaeger).toBe(true);
    expect(worker?.otelInJaeger).toBe(false);
  });

  test('a rejected credential reports unauthorized and still exits 0', async () => {
    answer = (response) => response.writeHead(401).end('no');
    const result = await run(configFor(tracing()), ['--json']);
    answer = (response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ services: ['mockingbird-web', 'jaeger'] }));
    expect(result.code).toBe(0);
    expect(result.records[0]?.tracing).toMatchObject({
      check: { status: 'unauthorized' },
    });
    expect(result.records[0]).not.toHaveProperty('otelInJaeger');
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
    const check = (result.records[0]?.tracing as { check: { detail: string } })
      .check;
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
    expect(result.records[0]?.tracing).toMatchObject({
      check: {
        status: 'error',
        detail: expect.stringContaining('TRACES_TEST_NO_SUCH_VAR'),
      },
    });
  });

  test('a project without tracing makes no request and has no check', async () => {
    const result = await run(configFor(undefined), ['--json']);
    expect(requests).toBe(0);
    expect(result.code).toBe(0);
    expect(result.records[0]).not.toHaveProperty('tracing');
  });
});

const PROJECT_ID = 'df361d61-2d2a-4838-9295-cd227871305b';
const plain = makeStyle(false);

const railwayRecord = (
  service: string,
  otelService?: string,
): ServiceRecord => ({
  configPath: '/home/me/.config/traces/config.json',
  configSource: 'global',
  project: 'mockingbird',
  matchedBy: 'flag',
  service,
  provider: 'railway',
  ref: {
    provider: 'railway',
    project: PROJECT_ID,
    service: `${service}-id`,
    ...(otelService === undefined ? {} : { otelService }),
  },
  auth: { status: 'ok', detail: 'token from keychain mockingbird.railway' },
});

const traceOnlyRecord = (service: string): ServiceRecord => ({
  ...railwayRecord(service),
  provider: undefined,
  auth: undefined,
  ref: { otelService: service },
});

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
  records: ReadonlyArray<ServiceRecord>,
  tracing?: TracingStatus,
): ServicesView => ({
  project: 'mockingbird',
  configPath: '/home/me/.config/traces/config.json',
  configSource: 'global',
  matchedBy: 'flag',
  home: '/home/me',
  ...(tracing === undefined ? {} : { tracing }),
  records,
});

describe('renderServices', () => {
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
        '  engine  railway  production  traces ✓',
        '  web     railway  production  traces ✓ as mockingbird-web',
        '  worker  railway  production  traces – not reporting',
        '  api     traces only          traces ✓',
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

  test('shows `as <otel>` only when the otel name differs from the key', () => {
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
    expect(output).toContain('engine  railway  production  traces ✓\n');
    expect(output).toContain('traces ✓ as mockingbird-web');
  });

  test('a service Jaeger does not report is marked not reporting', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('worker', 'mockingbird-worker')],
        jaeger({ status: 'reachable', services: ['other'] }),
      ),
      plain,
    );
    expect(output).toContain('traces – not reporting');
  });

  test('a trace-only service spans the provider and env columns', () => {
    const output = renderServices(
      viewOf(
        [railwayRecord('engine'), traceOnlyRecord('api')],
        jaeger({ status: 'reachable', services: ['engine', 'api'] }),
      ),
      plain,
    );
    expect(output).toContain('  api     traces only          traces ✓');
  });

  test('without a tracing block there is no traces column and no jaeger line', () => {
    const output = renderServices(viewOf([railwayRecord('engine')]), plain);
    expect(output).toContain('  engine  railway  production\n');
    expect(output).not.toContain('traces ');
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
    expect(output).toContain('  engine  railway  production\n');
    expect(output).not.toContain('traces ✓');
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
    const record: ServiceRecord = {
      ...railwayRecord('engine'),
      auth: {
        status: 'missing',
        detail: 'traces secret set mockingbird.railway',
      },
    };
    const output = renderServices(viewOf([record]), plain);
    expect(output).toContain(
      `  railway  project ${PROJECT_ID}  ✗ missing\n           traces secret set mockingbird.railway`,
    );
  });

  test('one provider line per Railway project and per Vercel team or project', () => {
    const vercel = (project: string, team?: string): ServiceRecord => ({
      ...railwayRecord(project),
      provider: 'vercel',
      ref: {
        provider: 'vercel',
        project,
        ...(team === undefined ? {} : { team }),
      },
      auth: { status: 'ok', detail: 'token from VERCEL_TOKEN' },
    });
    const output = renderServices(
      viewOf([
        railwayRecord('engine'),
        railwayRecord('worker'),
        vercel('site-a', 'acme'),
        vercel('site-b', 'acme'),
        vercel('solo'),
      ]),
      plain,
    );
    expect(output.split(`project ${PROJECT_ID}`).length).toBe(2);
    expect(output.match(/ team acme /g)?.length).toBe(1);
    expect(output).toContain('vercel   project solo');
    expect(output).toContain('  site-a  vercel\n');
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
    expect(output).toContain(
      'engine  railway  production  traces – not reporting',
    );
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
    expect(output).toContain('\u001b[2mtraces – not reporting\u001b[22m');
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
