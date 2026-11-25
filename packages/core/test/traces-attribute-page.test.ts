import { describe, expect, test } from 'bun:test';
import { Effect, Option } from 'effect';
import {
  attributePage,
  type Span,
  scanTraceWindow,
  type Trace,
  type TraceBackendInterface,
  type TraceQuery,
  type TraceSummary,
} from '#/index.js';
import { computeTraceSummary } from '#/traces/summary.js';

const BASE_NANO = 1_791_800_000_000_000_000n;

/** Trace `index` starts `index` milliseconds after BASE_NANO, so a higher index is newer. */
const traceAt = (
  index: number,
  tenant: string,
  options: { error?: boolean } = {},
): Trace => {
  const start = BASE_NANO + BigInt(index) * 1_000_000n;
  const span: Span = {
    traceId: `t${String(index).padStart(4, '0')}`,
    spanId: 's1',
    name: 'GET /',
    kind: 'server',
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 1_000_000n).toString(),
    durationMs: 1,
    status: options.error === true ? { code: 'error' } : { code: 'unset' },
    attributes: [{ key: 'tenant', value: tenant }],
    events: [],
    resource: { serviceName: 'web', attributes: [] },
  };
  return { traceId: span.traceId, spans: [span] };
};

const QUERY: TraceQuery = {
  service: 'web',
  startTimeMin: new Date(Number(BASE_NANO / 1_000_000n) - 1000).toISOString(),
  startTimeMax: new Date(
    Number(BASE_NANO / 1_000_000n) + 100_000,
  ).toISOString(),
};

/** A host without the legacy API: only full traces, newest at or before the bound. */
const v3Only = (store: ReadonlyArray<Trace>) => {
  const requests: Array<{ limit: number | undefined; max: string }> = [];
  const backend: Pick<
    TraceBackendInterface,
    'searchTagged' | 'searchFullTraces'
  > = {
    searchTagged: () => Effect.succeed(Option.none()),
    searchFullTraces: (query) => {
      requests.push({ limit: query.limit, max: query.startTimeMax });
      const bound = BigInt(Date.parse(query.startTimeMax)) * 1_000_000n;
      return Effect.succeed(
        store
          .filter(
            (candidate) =>
              BigInt(computeTraceSummary(candidate).startTimeUnixNano) <= bound,
          )
          .sort((left, right) =>
            computeTraceSummary(right).startTimeUnixNano.localeCompare(
              computeTraceSummary(left).startTimeUnixNano,
            ),
          )
          .slice(0, query.limit),
      );
    },
  };
  return { backend, requests };
};

const scan = (
  backend: Pick<TraceBackendInterface, 'searchTagged' | 'searchFullTraces'>,
  options: {
    limit?: number;
    scanCap?: number;
    requireError?: boolean;
    attributes?: Record<string, string>;
  } = {},
) =>
  Effect.runPromise(
    scanTraceWindow(
      {
        limit: options.limit ?? 50,
        scanCap: options.scanCap ?? 1000,
        pageSize: 4,
        fetchPage: attributePage({
          backend,
          query: QUERY,
          attributes: options.attributes ?? { tenant: 'acme' },
          windowEnd: QUERY.startTimeMax,
          requireError: options.requireError ?? false,
        }),
      },
      'client',
    ),
  );

const idsOf = (matches: ReadonlyArray<TraceSummary>) =>
  matches.map((match) => match.traceId);

describe('attributePage without a legacy API', () => {
  const store = Array.from({ length: 10 }, (_, index) =>
    traceAt(index + 1, index % 2 === 0 ? 'other' : 'acme', {
      error: index === 3,
    }),
  );

  test('matches spans on the client and reads the whole window when it is short enough', async () => {
    const { backend } = v3Only(store);
    const result = await scan(backend);
    expect(idsOf(result.matches)).toEqual([
      't0002',
      't0004',
      't0006',
      't0008',
      't0010',
    ]);
    expect(result).toMatchObject({ scanned: 10, capped: false });
    expect(result.next).toBeUndefined();
  });

  test('every trace read counts toward the cap, matches or not, and a capped scan can resume', async () => {
    const { backend } = v3Only(store);
    const first = await scan(backend, { scanCap: 4 });
    expect(result(first)).toEqual({
      ids: ['t0008', 't0010'],
      scanned: 4,
      capped: true,
    });
    expect(first.next).toBeDefined();
  });

  test('requireError keeps matching traces that have error spans', async () => {
    const { backend } = v3Only(store);
    const result = await scan(backend, { requireError: true });
    expect(idsOf(result.matches)).toEqual(['t0004']);
  });

  test('stops at the limit and leaves a cursor when older matches remain', async () => {
    const { backend } = v3Only(store);
    const result = await scan(backend, { limit: 2 });
    expect(idsOf(result.matches)).toEqual(['t0008', 't0010']);
    expect(result.capped).toBe(false);
    expect(result.next).toBeDefined();
  });
});

const result = (scanResult: Awaited<ReturnType<typeof scan>>) => ({
  ids: idsOf(scanResult.matches),
  scanned: scanResult.scanned,
  capped: scanResult.capped,
});

describe('attributePage with a legacy API', () => {
  test('takes the server matches as hits without reading full traces', async () => {
    const legacy = [traceAt(3, 'acme'), traceAt(1, 'acme')].map(
      computeTraceSummary,
    );
    let fullTraceReads = 0;
    const result = await scan({
      searchTagged: () => Effect.succeed(Option.some(legacy)),
      searchFullTraces: () => {
        fullTraceReads += 1;
        return Effect.succeed([]);
      },
    });
    expect(idsOf(result.matches)).toEqual(['t0001', 't0003']);
    expect(fullTraceReads).toBe(0);
  });

  test('requireError filters the server matches by their error counts', async () => {
    const legacy = [
      traceAt(3, 'acme', { error: true }),
      traceAt(1, 'acme'),
    ].map(computeTraceSummary);
    const result = await scan(
      {
        searchTagged: () => Effect.succeed(Option.some(legacy)),
        searchFullTraces: () => Effect.succeed([]),
      },
      { requireError: true },
    );
    expect(idsOf(result.matches)).toEqual(['t0003']);
  });
});
