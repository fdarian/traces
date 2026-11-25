import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpanRow } from '@traces/core';
import { formatSpanTree } from '#/output.ts';

const TRACE_ID = 'a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e';
const MISSING_ID = 'ffffffffffffffffffffffffffffffff';
const BASE_NANO = 1_791_800_000_000_000_000n;

const at = (offsetMs: number) =>
  (BASE_NANO + BigInt(offsetMs) * 1_000_000n).toString();

const otelSpan = (
  spanId: string,
  parentSpanId: string | undefined,
  startMs: number,
  durationMs: number,
  extra: Record<string, unknown> = {},
) => ({
  traceId: TRACE_ID,
  spanId,
  ...(parentSpanId === undefined ? {} : { parentSpanId }),
  name: `op-${spanId}`,
  kind: 'SPAN_KIND_SERVER',
  startTimeUnixNano: at(startMs),
  endTimeUnixNano: at(startMs + durationMs),
  ...extra,
});

const stack = [
  'TypeError: x is undefined',
  '    at handler (src/a.ts:10:5)',
  '    at dispatch (src/b.ts:20:7)',
  '    at run (src/c.ts:30:9)',
  '    at main (src/d.ts:40:1)',
].join('\n');

const fakeTrace = {
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
              // Listed out of order on purpose: the CLI must sort, not trust Jaeger.
              otelSpan('c2', 'root', 300, 50, {
                status: { code: 'STATUS_CODE_OK' },
              }),
              otelSpan('orphan', 'gone', 5, 10),
              otelSpan('root', undefined, 0, 412, {
                attributes: [
                  { key: 'http.status_code', value: { intValue: '500' } },
                ],
              }),
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'engine' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              otelSpan('c1', 'root', 100, 120, {
                status: { code: 'STATUS_CODE_ERROR', message: 'query failed' },
                events: [
                  {
                    name: 'exception',
                    timeUnixNano: at(150),
                    attributes: [
                      {
                        key: 'exception.type',
                        value: { stringValue: 'TypeError' },
                      },
                      {
                        key: 'exception.message',
                        value: { stringValue: 'x is undefined' },
                      },
                      {
                        key: 'exception.stacktrace',
                        value: { stringValue: stack },
                      },
                    ],
                  },
                ],
              }),
            ],
          },
        ],
      },
    ],
  },
};

interface SeenRequest {
  readonly pathname: string;
  readonly apiKey: string | null;
}

let server: Server;
let dir: string;
let seen: Array<SeenRequest> = [];
let rejectAuth = false;

const configFor = (tracing: unknown) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      projects: {
        app: {
          matcher: { type: 'git', repo: 'acme/app' },
          ...(tracing === undefined ? {} : { tracing }),
          services: { web: { otelService: 'mockingbird-web' } },
        },
      },
    }),
  );
  return path;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'traces-trace-'));
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    seen.push({
      pathname: url.pathname,
      apiKey:
        request.headers['x-api-key'] === undefined
          ? null
          : String(request.headers['x-api-key']),
    });
    if (rejectAuth) {
      response.writeHead(401).end('no');
      return;
    }
    if (url.pathname === `/proxy/api/v3/traces/${TRACE_ID}`) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(fakeTrace));
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(() => {
  server.close();
});

const tracingBlock = () => ({
  provider: 'jaeger',
  url: `http://localhost:${(server.address() as AddressInfo).port}/proxy`,
  headers: { 'X-API-Key': 'secret-token' },
});

const spawnTrace = async (
  traceId: string,
  config?: string,
  flags: ReadonlyArray<string> = [],
) => {
  seen = [];
  const child = Bun.spawn(
    [
      'bun',
      'src/main.ts',
      'trace',
      traceId,
      '--project',
      'app',
      '--config',
      config ?? configFor(tracingBlock()),
      ...flags,
    ],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const run = async (traceId: string, config?: string) => {
  const result = await spawnTrace(traceId, config, ['--json']);
  const rows = result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SpanRow);
  return { rows, stderr: result.stderr, code: result.code };
};

describe('traces trace against a fake Jaeger', () => {
  test('emits SpanRow records depth first, sends the header, and promotes the exception', async () => {
    const result = await run(TRACE_ID);
    expect(result.code).toBe(0);
    expect(seen).toEqual([
      { pathname: `/proxy/api/v3/traces/${TRACE_ID}`, apiKey: 'secret-token' },
    ]);
    expect(result.rows.map((row) => `${row.spanId}@${row.depth}`)).toEqual([
      'root@0',
      'c1@1',
      'c2@1',
      'orphan@0',
    ]);
    const [root, failing, ok, orphan] = result.rows;
    expect(root).toEqual({
      traceId: TRACE_ID,
      spanId: 'root',
      depth: 0,
      service: 'mockingbird-web',
      name: 'op-root',
      kind: 'server',
      startTs: '2026-10-12T10:13:20.000000000Z',
      durationMs: 412,
      status: 'unset',
      attrs: { 'http.status_code': 500 },
      events: [],
    });
    expect(failing?.service).toBe('engine');
    expect(failing?.parentSpanId).toBe('root');
    expect(failing?.status).toBe('error');
    expect(failing?.statusMessage).toBe('query failed');
    expect(failing?.exception).toEqual({
      type: 'TypeError',
      message: 'x is undefined',
      stacktrace: stack,
    });
    expect(ok?.status).toBe('ok');
    expect(orphan?.parentSpanId).toBe('gone');
  });

  test('a trace Jaeger does not have exits 1 with a retention hint', async () => {
    const result = await run(MISSING_ID);
    expect(result.code).toBe(1);
    expect(result.rows).toEqual([]);
    expect(result.stderr).toContain(`trace ${MISSING_ID} not found`);
    expect(result.stderr).toContain('hint:');
    expect(result.stderr).toContain('storage backend');
  });

  test.each([
    ['a042d0ba'],
    ['a042d0ba…'],
    ['not-hex-not-hex-not-hex-not-hex!'],
  ])('%j exits 2 before any request', async (traceId) => {
    const result = await run(traceId);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('is not a trace id');
    expect(seen).toEqual([]);
  });

  test('a project without tracing exits 2 with the block to add', async () => {
    const result = await run(TRACE_ID, configFor(undefined));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no tracing config');
  });

  test('a rejected credential exits 3', async () => {
    rejectAuth = true;
    const result = await run(TRACE_ID);
    rejectAuth = false;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('HTTP 401');
  });
});

describe('traces trace text output when piped', () => {
  test('prints the span tree with no ANSI codes', async () => {
    const result = await spawnTrace(TRACE_ID);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout.split('\n')[0]).toBe(
      '  +0ms 412ms mockingbird-web op-root',
    );
  });
});

describe('formatSpanTree', () => {
  const row = (overrides: Partial<SpanRow>): SpanRow => ({
    traceId: TRACE_ID,
    spanId: 's',
    depth: 0,
    service: 'web',
    name: 'GET /x',
    kind: 'server',
    startTs: '2026-10-12T10:13:20.000000000Z',
    durationMs: 412,
    status: 'unset',
    attrs: {},
    events: [],
    ...overrides,
  });

  test('indents by depth, offsets from the earliest span, and aligns the columns', () => {
    expect(
      formatSpanTree([
        row({}),
        row({
          spanId: 'c',
          depth: 1,
          service: 'engine',
          name: 'query',
          startTs: '2026-10-12T10:13:20.100000000Z',
          durationMs: 20,
          status: 'ok',
        }),
      ]),
    ).toEqual(['  +0ms 412ms web GET /x', '+100ms  20ms   engine query ok']);
  });

  test('an error span gets ERR, its exception and the top 3 frames', () => {
    expect(
      formatSpanTree([
        row({
          depth: 1,
          status: 'error',
          exception: {
            type: 'TypeError',
            message: 'x is undefined\nsecond line',
            stacktrace: stack,
          },
        }),
      ]),
    ).toEqual([
      '+0ms 412ms   web GET /x ERR',
      `${' '.repeat(15)}! TypeError: x is undefined`,
      `${' '.repeat(17)}at handler (src/a.ts:10:5)`,
      `${' '.repeat(17)}at dispatch (src/b.ts:20:7)`,
      `${' '.repeat(17)}at run (src/c.ts:30:9)`,
    ]);
  });

  test('an exception without a stack trace prints no frames', () => {
    expect(
      formatSpanTree([
        row({
          status: 'error',
          exception: { type: 'TypeError', message: 'x is undefined' },
        }),
      ]),
    ).toEqual([
      '+0ms 412ms web GET /x ERR',
      `${' '.repeat(13)}! TypeError: x is undefined`,
    ]);
  });

  test('an error without an exception shows its status message', () => {
    expect(
      formatSpanTree([
        row({ status: 'error', statusMessage: 'query failed\nmore' }),
      ]),
    ).toEqual(['+0ms 412ms web GET /x ERR', `${' '.repeat(13)}! query failed`]);
  });

  test('stack traces without `at` frames fall back to their first lines', () => {
    const lines = formatSpanTree([
      row({
        status: 'error',
        exception: {
          type: 'ValueError',
          message: 'bad',
          stacktrace: 'Traceback:\n  File a\n  File b\n  File c',
        },
      }),
    ]);
    expect(lines.slice(2)).toEqual([
      `${' '.repeat(15)}Traceback:`,
      `${' '.repeat(15)}File a`,
      `${' '.repeat(15)}File b`,
    ]);
  });
});
