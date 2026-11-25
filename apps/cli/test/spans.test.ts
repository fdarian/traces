import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { formatTraceLine } from '#/output.ts';
import { parseDuration } from '#/time.ts';
import { legacyTraceOf, matchesLegacyTags } from './legacy-jaeger.ts';

const BASE_NANO = 1_791_800_000_000_000_000n;
const ERROR_INDEXES = [2, 5, 6, 9, 11];

const nanoIso = (nanos: bigint) =>
  `${new Date(Number(nanos / 1_000_000n)).toISOString().slice(0, -1)}${String(nanos % 1_000_000n).padStart(6, '0')}Z`;

const traceAt = (index: number, traceId: string, errorSpanCount: number) => {
  const start = BASE_NANO + BigInt(index) * 1_000_000_000n;
  return {
    traceId,
    rootServiceName: 'mockingbird-web',
    rootOperationName: 'GET /api/x',
    spanCount: 3,
    errorSpanCount,
    services: [{ name: 'mockingbird-web', spanCount: 3 }],
    minStartTimeUnixNano: start.toString(),
    maxEndTimeUnixNano: (start + 412_000_000n).toString(),
  };
};

/** Trace `index` starts `index` seconds after BASE_NANO, so a higher index is newer. */
const fakeTraces = Array.from({ length: 12 }, (_, index) =>
  traceAt(
    index,
    `${String(index).padStart(2, '0')}`.repeat(16),
    ERROR_INDEXES.includes(index) ? 2 : 0,
  ),
);

/** The trace as `/api/v3/traces` returns it: one span, tagged `tenant=a` on even indexes and `tenant=b` on odd ones. */
const fullTraceOf = (summary: ReturnType<typeof traceAt>) => {
  const index = Number(summary.traceId.slice(0, 2));
  return {
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: 'mockingbird-web' } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: 'test' },
        spans: [
          {
            traceId: summary.traceId,
            spanId: '0000000000000001',
            name: 'GET /api/x',
            kind: 2,
            startTimeUnixNano: summary.minStartTimeUnixNano,
            endTimeUnixNano: summary.maxEndTimeUnixNano,
            attributes: [
              {
                key: 'tenant',
                value: { stringValue: index % 2 === 0 ? 'a' : 'b' },
              },
            ],
            status: summary.errorSpanCount > 0 ? { code: 2 } : {},
          },
        ],
      },
    ],
  };
};

/** 1100 error-free traces, newest first by index, so a scan reaches its cap without finding an error. */
const quietTraces = Array.from({ length: 1100 }, (_, index) =>
  traceAt(index, index.toString(16).padStart(32, '0'), 0),
);

interface SeenRequest {
  readonly pathname: string;
  readonly params: Record<string, string>;
  readonly apiKey: string | null;
}

let server: Server;
let dir: string;
let seen: Array<SeenRequest> = [];
let rejectAuth = false;
let quietBacklog = false;
let legacyStatus: number | undefined;

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
          },
        },
      },
    }),
  );
  return path;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'traces-spans-'));
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const params = Object.fromEntries(url.searchParams);
    seen.push({
      pathname: url.pathname,
      params,
      apiKey:
        request.headers['x-api-key'] === undefined
          ? null
          : String(request.headers['x-api-key']),
    });
    if (rejectAuth) {
      response.writeHead(401).end('no');
      return;
    }
    const legacy = url.pathname === '/proxy/api/traces';
    if (legacy && legacyStatus !== undefined) {
      response.writeHead(legacyStatus).end('no legacy');
      return;
    }
    const fullTraces = url.pathname === '/proxy/api/v3/traces';
    if (
      !legacy &&
      !fullTraces &&
      url.pathname !== '/proxy/api/v3/trace-summaries'
    ) {
      response.writeHead(404).end('not found');
      return;
    }
    const max = legacy
      ? nanoIso(BigInt(params.end ?? '0') * 1000n)
      : (params['query.start_time_max'] ?? '');
    const asked = Number(
      (legacy ? params.limit : params['query.num_traces']) ?? '20',
    );
    const summaries = (quietBacklog ? quietTraces : fakeTraces)
      .filter((trace) => nanoIso(BigInt(trace.minStartTimeUnixNano)) <= max)
      .filter(
        (trace) => !legacy || matchesLegacyTags(trace, params.tags ?? null),
      )
      .sort((left, right) =>
        right.minStartTimeUnixNano.localeCompare(left.minStartTimeUnixNano),
      )
      .slice(0, asked);
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify(
          legacy
            ? { data: summaries.map(legacyTraceOf), errors: null }
            : fullTraces
              ? { result: { resourceSpans: summaries.map(fullTraceOf) } }
              : { summaries },
        ),
      );
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

const WINDOW = [
  '--since',
  '2026-10-01T00:00:00Z',
  '--until',
  '2026-10-30T00:00:00Z',
];

const spawnSpans = async (args: ReadonlyArray<string>, config?: string) => {
  seen = [];
  const child = Bun.spawn(
    [
      'bun',
      'src/main.ts',
      'spans',
      'web',
      '--project',
      'app',
      '--config',
      config ?? configFor(tracingBlock()),
      ...args,
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

const run = async (args: ReadonlyArray<string>, config?: string) => {
  const result = await spawnSpans([...args, '--json'], config);
  const rows = result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const more = result.stderr
    .split('\n')
    .find((line) => line.startsWith('more: '));
  const cursor =
    more === undefined ? undefined : /--cursor (\S+)/.exec(more)?.[1];
  return {
    rows,
    stderr: result.stderr,
    code: result.code,
    more,
    cursor,
  };
};

const idsOf = (rows: ReadonlyArray<Record<string, unknown>>) =>
  rows.map((row) => String(row.traceId).slice(0, 2));

describe('traces spans against a fake Jaeger', () => {
  test('an empty capped error scan says it only covered part of the window', async () => {
    quietBacklog = true;
    try {
      const page = await run([...WINDOW, '--errors', '--limit', '2']);
      expect(page.rows).toEqual([]);
      expect(page.stderr).toContain('no error traces for mockingbird-web');
      expect(page.stderr).toContain('in the scanned range (');
      expect(page.stderr).toContain('); more below');
      expect(page.stderr).not.toContain('in 2026-10-01');
      expect(page.more).toBeDefined();
    } finally {
      quietBacklog = false;
    }
  });

  test('emits TraceRow records, sends the header and the service, and pages backwards without gaps', async () => {
    const config = configFor(tracingBlock());
    const first = await run([...WINDOW, '--limit', '5'], config);
    expect(first.code).toBe(0);
    expect(idsOf(first.rows)).toEqual(['07', '08', '09', '10', '11']);
    expect(first.rows[0]).toEqual({
      traceId: '07'.repeat(16),
      rootService: 'mockingbird-web',
      rootOperation: 'GET /api/x',
      startTs: '2026-10-12T10:13:27.000000000Z',
      durationMs: 412,
      spanCount: 3,
      errorSpanCount: 0,
      services: ['mockingbird-web'],
    });
    expect(seen[0]?.apiKey).toBe('secret-token');
    expect(seen[0]?.params['query.service_name']).toBe('mockingbird-web');
    expect(first.cursor).toBeDefined();
    expect(first.more).toContain('--limit 5');

    const second = await run(
      [...WINDOW, '--limit', '5', '--cursor', first.cursor ?? ''],
      config,
    );
    expect(idsOf(second.rows)).toEqual(['02', '03', '04', '05', '06']);
    const third = await run(
      [...WINDOW, '--limit', '5', '--cursor', second.cursor ?? ''],
      config,
    );
    expect(idsOf(third.rows)).toEqual(['00', '01']);
    expect(third.cursor).toBeUndefined();
  });

  test('--errors keeps only error traces and pages through them', async () => {
    const config = configFor(tracingBlock());
    const first = await run([...WINDOW, '--errors', '--limit', '2'], config);
    expect(idsOf(first.rows)).toEqual(['09', '11']);
    expect(first.more).toContain('--errors');
    expect(
      JSON.parse(Buffer.from(first.cursor ?? '', 'base64url').toString()).mode,
    ).toBe('filtered');
    const second = await run(
      [...WINDOW, '--errors', '--limit', '2', '--cursor', first.cursor ?? ''],
      config,
    );
    expect(idsOf(second.rows)).toEqual(['05', '06']);
    const third = await run(
      [...WINDOW, '--errors', '--limit', '2', '--cursor', second.cursor ?? ''],
      config,
    );
    expect(idsOf(third.rows)).toEqual(['02']);
    // A resumed page keeps asking Jaeger to filter instead of rerunning the unfiltered fallback.
    expect(
      seen.every((request) => request.pathname === '/proxy/api/traces'),
    ).toBe(true);
  });

  describe.each([404, 405])('when /api/traces answers %d', (status) => {
    const withoutLegacy = async <A>(use: () => Promise<A>) => {
      legacyStatus = status;
      try {
        return await use();
      } finally {
        legacyStatus = undefined;
      }
    };

    test('--errors pages the summaries without a filter and says nothing is wrong', async () => {
      const config = configFor(tracingBlock());
      const first = await withoutLegacy(() =>
        run([...WINDOW, '--errors', '--limit', '2'], config),
      );
      expect(first.code).toBe(0);
      expect(idsOf(first.rows)).toEqual(['09', '11']);
      const second = await withoutLegacy(() =>
        run(
          [
            ...WINDOW,
            '--errors',
            '--limit',
            '2',
            '--cursor',
            first.cursor ?? '',
          ],
          config,
        ),
      );
      expect(idsOf(second.rows)).toEqual(['05', '06']);
      expect(
        seen.every(
          (request) =>
            request.pathname === '/proxy/api/v3/trace-summaries' ||
            request.pathname === '/proxy/api/traces',
        ),
      ).toBe(true);
    });

    test('--attr filters /api/v3/traces on the client', async () => {
      const result = await withoutLegacy(() =>
        run([...WINDOW, '--attr', 'tenant=a']),
      );
      expect(result.code).toBe(0);
      expect(idsOf(result.rows)).toEqual(['00', '02', '04', '06', '08', '10']);
      expect(seen.map((request) => request.pathname)).toEqual([
        '/proxy/api/traces',
        '/proxy/api/v3/traces',
      ]);
    });

    test('--attr stops at the scan cap, says so on stderr and hands back a cursor to keep scanning', async () => {
      quietBacklog = true;
      try {
        const first = await withoutLegacy(() =>
          run([...WINDOW, '--attr', 'tenant=b', '--limit', '5']),
        );
        expect(first.code).toBe(0);
        expect(first.rows).toEqual([]);
        expect(first.stderr).toContain(
          'note: scanned 1000 traces (cap 1000) and found 0 of 5 traces matching --attr; older traces were not read.',
        );
        expect(first.stderr).toContain('in the scanned range (');
        expect(first.more).toContain('--attr tenant=b');
        const resumed = await withoutLegacy(() =>
          run([
            ...WINDOW,
            '--attr',
            'tenant=b',
            '--limit',
            '5',
            '--cursor',
            first.cursor ?? '',
          ]),
        );
        // 1100 traces: the second scan reads the last 100 and reaches the window's start.
        expect(resumed.stderr).not.toContain('note: scanned');
        expect(resumed.more).toBeUndefined();
      } finally {
        quietBacklog = false;
      }
    });

    test('--attr that finds its limit before the cap prints no cap note', async () => {
      const result = await withoutLegacy(() =>
        run([...WINDOW, '--attr', 'tenant=a', '--limit', '2']),
      );
      expect(idsOf(result.rows)).toEqual(['08', '10']);
      expect(result.stderr).not.toContain('note: scanned');
      expect(result.more).toBeDefined();
    });

    test('--errors with --attr keeps the matching traces that have error spans', async () => {
      const result = await withoutLegacy(() =>
        run([...WINDOW, '--errors', '--attr', 'tenant=a']),
      );
      expect(result.code).toBe(0);
      expect(idsOf(result.rows)).toEqual(['02', '06']);
    });
  });

  test('passes op, durations and attributes to Jaeger', async () => {
    const result = await run([
      ...WINDOW,
      '--op',
      'GET /api/x',
      '--min-duration',
      '1s',
      '--max-duration',
      '2m',
      '--attr',
      'http.status_code=500',
      '--attr',
      'tenant=a=b',
    ]);
    expect(result.code).toBe(0);
    const params = seen[0]?.params ?? {};
    expect(seen[0]?.pathname).toBe('/proxy/api/traces');
    expect(params.operation).toBe('GET /api/x');
    expect(params.minDuration).toBe('1s');
    expect(params.maxDuration).toBe('2m');
    expect(JSON.parse(params.tags ?? '{}')).toEqual({
      'http.status_code': '500',
      tenant: 'a=b',
    });
  });

  test.each([
    [['--min-duration', 'fast'], '--min-duration'],
    [['--min-duration', '2s', '--max-duration', '1s'], 'longer than'],
    [['--attr', 'novalue'], '--attr'],
    [['--limit', '500'], '--limit'],
    [['--cursor', 'garbage'], 'invalid --cursor'],
  ])('%j exits 2 before any request', async (args, message) => {
    const result = await run([...WINDOW, ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(seen).toEqual([]);
  });

  test('a project without tracing exits 2 with the block to add', async () => {
    const result = await run(WINDOW, configFor(undefined));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no tracing config');
  });

  test('a rejected credential exits 3', async () => {
    rejectAuth = true;
    const result = await run(WINDOW);
    rejectAuth = false;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('HTTP 401');
  });

  test('an empty window says so on stderr and exits 0', async () => {
    const result = await run([
      '--since',
      '2020-01-01T00:00:00Z',
      '--until',
      '2020-01-02T00:00:00Z',
    ]);
    expect(result.code).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.stderr).toContain('no traces');
  });
});

describe('parseDuration', () => {
  test.each([
    ['500ms', 500],
    ['1s', 1000],
    ['1.5s', 1500],
    ['2m', 120_000],
    ['1h', 3_600_000],
  ])('%s', async (text, ms) => {
    const parsed = await Effect.runPromise(
      parseDuration('--min-duration', text),
    );
    expect(parsed).toEqual({ text, ms });
  });

  test.each([
    '1',
    's',
    '1d',
    '-1s',
    '1 s',
    '1us',
  ])('rejects %j', async (text) => {
    const result = await Effect.runPromise(
      parseDuration('--min-duration', text).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
  });
});

describe('traces spans text output when piped', () => {
  test('prints the full trace id with no ellipsis and no ANSI codes', async () => {
    const result = await spawnSpans(WINDOW);
    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe(
      `10-12 10:13:20.000Z 412ms mockingbird-web GET /api/x  ${'00'.repeat(16)}`,
    );
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout).not.toContain('…');
  });
});

describe('formatTraceLine', () => {
  const row = {
    traceId: 'a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e',
    rootService: 'mockingbird-web',
    rootOperation: 'GET /api/x',
    startTs: '2026-10-12T02:55:09.123456789Z',
    durationMs: 412,
    spanCount: 5,
    errorSpanCount: 0,
    services: ['mockingbird-web'],
  };

  test('prints the full id without an ellipsis when not on a terminal', () => {
    expect(formatTraceLine(row, false, false)).toBe(
      '02:55:09.123Z 412ms mockingbird-web GET /api/x  a042d0ba5f0e4b9c8d7e6f5a4b3c2d1e',
    );
  });

  test('matches the documented line, with ERR only when there are error spans', () => {
    expect(formatTraceLine({ ...row, errorSpanCount: 2 }, false, true)).toBe(
      '02:55:09.123Z 412ms ERR×2 mockingbird-web GET /api/x  a042d0ba…',
    );
    expect(formatTraceLine({ ...row, errorSpanCount: 0 }, false, true)).toBe(
      '02:55:09.123Z 412ms mockingbird-web GET /api/x  a042d0ba…',
    );
    expect(formatTraceLine(row, true, true)).toBe(
      '10-12 02:55:09.123Z 412ms mockingbird-web GET /api/x  a042d0ba…',
    );
  });
});
