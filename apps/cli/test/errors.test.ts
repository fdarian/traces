import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_NANO = 1_791_800_000_000_000_000n;
const INDEXES = [0, 1, 2, 3];
const ERROR_INDEXES = [1, 2, 3];

const traceIdOf = (index: number) => String(index).padStart(2, '0').repeat(16);
const at = (index: number) =>
  (BASE_NANO + BigInt(index) * 1_000_000_000n).toString();

const summaryOf = (index: number) => ({
  traceId: traceIdOf(index),
  rootServiceName: 'mockingbird-web',
  rootOperationName: 'GET /api/x',
  spanCount: 2,
  errorSpanCount: ERROR_INDEXES.includes(index) ? 2 : 0,
  services: [
    { name: 'mockingbird-web', spanCount: 1 },
    { name: 'x-data', spanCount: 1 },
  ],
  minStartTimeUnixNano: at(index),
  maxEndTimeUnixNano: (BigInt(at(index)) + 412_000_000n).toString(),
});

const traceOf = (index: number) => ({
  result: {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'mockingbird-web' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceIdOf(index),
                spanId: 'web',
                name: 'GET /api/x',
                kind: 'SPAN_KIND_SERVER',
                startTimeUnixNano: at(index),
                endTimeUnixNano: (BigInt(at(index)) + 400_000_000n).toString(),
                status: { code: 'STATUS_CODE_ERROR' },
                events: [
                  {
                    name: 'exception',
                    timeUnixNano: at(index),
                    attributes: [
                      {
                        key: 'exception.type',
                        value: { stringValue: 'TypeError' },
                      },
                      {
                        key: 'exception.message',
                        value: { stringValue: `no user ${index}41` },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'x-data' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceIdOf(index),
                spanId: 'x',
                parentSpanId: 'web',
                name: 'query',
                kind: 'SPAN_KIND_CLIENT',
                startTimeUnixNano: at(index),
                endTimeUnixNano: (BigInt(at(index)) + 100_000_000n).toString(),
                status: { code: 'STATUS_CODE_ERROR', message: 'timeout' },
              },
            ],
          },
        ],
      },
    ],
  },
});

let server: Server;
let dir: string;
let failingService: string | undefined;
let seen: Array<{ service: string | undefined; apiKey: string | null }> = [];

const SERVICES = {
  web: { otelService: 'mockingbird-web' },
  x: { otelService: 'x-data' },
};

const configFor = (tracing: boolean, services: object = SERVICES) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      projects: {
        app: {
          matcher: { type: 'git', repo: 'acme/app' },
          ...(tracing
            ? {
                tracing: {
                  provider: 'jaeger',
                  url: `http://localhost:${(server.address() as AddressInfo).port}/proxy`,
                  headers: { 'X-API-Key': 'secret-token' },
                },
              }
            : {}),
          services,
        },
      },
    }),
  );
  return path;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'traces-errors-'));
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const service = url.searchParams.get('query.service_name') ?? undefined;
    seen.push({
      service,
      apiKey:
        request.headers['x-api-key'] === undefined
          ? null
          : String(request.headers['x-api-key']),
    });
    if (url.pathname === '/proxy/api/v3/trace-summaries') {
      if (service === failingService) {
        response.writeHead(500).end('boom');
        return;
      }
      const max =
        BigInt(Date.parse(url.searchParams.get('query.start_time_max') ?? '')) *
        1_000_000n;
      const summaries = INDEXES.map(summaryOf).filter(
        (summary) => BigInt(summary.minStartTimeUnixNano) <= max,
      );
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ summaries }));
      return;
    }
    const match = /\/proxy\/api\/v3\/traces\/(\w+)$/.exec(url.pathname);
    const index = INDEXES.find((i) => traceIdOf(i) === match?.[1]);
    if (index === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(traceOf(index)));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(() => {
  server.close();
});

const run = async (args: ReadonlyArray<string>, config: string) => {
  seen = [];
  const child = Bun.spawn(
    [
      'bun',
      'src/main.ts',
      'errors',
      '--project',
      'app',
      '--config',
      config,
      '--since',
      '2026-10-01T00:00:00Z',
      '--until',
      '2026-10-30T00:00:00Z',
      ...args,
    ],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  const rows = stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { rows, stderr, code };
};

const summarize = (rows: ReadonlyArray<Record<string, unknown>>) =>
  rows.map((row) => `${row.service}:${row.source}:${row.count}`).sort();

describe('traces errors, trace side, against a fake Jaeger', () => {
  test('trace-only services are enough: groups error spans per service, with trace hints', async () => {
    failingService = undefined;
    const result = await run([], configFor(true));
    expect(result.code).toBe(0);
    expect(summarize(result.rows)).toEqual(['web:traces:3', 'x:traces:3']);
    const web = result.rows.find((row) => row.service === 'web');
    expect(web).toMatchObject({
      source: 'traces',
      provider: 'jaeger',
      sample: 'TypeError: no user 341',
      deploymentIds: [],
      partial: false,
      traceId: traceIdOf(3),
      traceIds: [traceIdOf(3), traceIdOf(2), traceIdOf(1)],
    });
    expect(web).not.toHaveProperty('environment');
    expect(web?.hint).toContain(`traces trace ${traceIdOf(3)} --project app`);
    expect(web?.hint).toContain('--config');
    expect(seen.every((request) => request.apiKey === 'secret-token')).toBe(
      true,
    );
  });

  test('naming a service scans only its otelService', async () => {
    failingService = undefined;
    const result = await run(['x'], configFor(true));
    expect(summarize(result.rows)).toEqual(['x:traces:3']);
    expect(
      seen
        .filter((request) => request.service !== undefined)
        .every((request) => request.service === 'x-data'),
    ).toBe(true);
  });

  test('a failing service does not hide the others: successes on stdout, error on stderr, exit 1', async () => {
    failingService = 'x-data';
    const result = await run([], configFor(true));
    expect(result.code).toBe(1);
    expect(summarize(result.rows)).toEqual(['web:traces:3']);
    expect(result.stderr).toContain('error: x (traces):');
    failingService = undefined;
  });

  test('a single failing service keeps its own error and exit code', async () => {
    failingService = 'x-data';
    const result = await run(['x'], configFor(true));
    expect(result.code).toBe(1);
    expect(result.rows).toEqual([]);
    expect(result.stderr).toContain('error:');
    expect(result.stderr).not.toContain('(traces)');
    failingService = undefined;
  });

  test('--source logs on a project of trace-only services exits 2', async () => {
    const result = await run(['--source', 'logs'], configFor(true));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('trace-only');
  });

  test('--source traces without a tracing block exits 2', async () => {
    const result = await run(['--source', 'traces'], configFor(false));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no tracing config');
  });

  test('a window with no error traces says so for error spans', async () => {
    const config = configFor(true);
    const child = Bun.spawn(
      [
        'bun',
        'src/main.ts',
        'errors',
        '--project',
        'app',
        '--config',
        config,
        '--since',
        '2020-01-01T00:00:00Z',
        '--until',
        '2020-01-02T00:00:00Z',
      ],
      { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('no error spans for web, x');
  });
});
