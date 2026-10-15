import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTracing } from '#/commands/services.ts';

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

  test('the human tracing block names the status and the missing otelServices', () => {
    const base = {
      provider: 'jaeger',
      url: 'https://j.example',
      headers: [],
    } as const;
    const block = formatTracing(
      { ...base, check: { status: 'reachable', services: ['a', 'b'] } },
      [{ service: 'worker', otelService: 'mockingbird-worker' }],
    );
    expect(block).toContain('  status reachable (a, b)');
    expect(block).toContain('  worker → mockingbird-worker: not in Jaeger');
    expect(
      formatTracing({ ...base, check: { status: 'unauthorized' } }, []),
    ).toContain('  status unauthorized');
    expect(
      formatTracing(
        { ...base, check: { status: 'error', detail: 'no answer within 5s' } },
        [],
      ),
    ).toContain('  status error: no answer within 5s');
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
