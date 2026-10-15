import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  decodeCursor,
  type ErrorScanMode,
  encodeCursor,
  errorSearchAttributes,
  fromTraceCursor,
  type PageResume,
  pageTraces,
  scanErrorTraces,
  TraceAttributeSearchUnavailable,
  type TraceSummary,
  toTraceCursor,
  toTraceRow,
  traceFetchSize,
} from '#/index.js';
import { nanoToIso } from '#/normalize.js';

const BASE_NANO = 1_791_800_000_000_000_000n;

/** Trace `index` starts `index` milliseconds after BASE_NANO, so a higher index is newer. */
const summary = (index: number, errors: number | undefined): TraceSummary => ({
  traceId: `t${String(index).padStart(4, '0')}`,
  rootService: 'web',
  rootOperation: 'GET /',
  spanCount: 3,
  errorSpanCount: errors,
  services: [{ name: 'web', spanCount: 3 }],
  startTimeUnixNano: (BASE_NANO + BigInt(index) * 1_000_000n).toString(),
  durationMs: 10,
});

/** Jaeger as the pager sees it: the newest `size` traces at or before the bound, in no particular order. */
const fakeJaeger = (
  store: ReadonlyArray<TraceSummary>,
  /** What the server does with the error filter: apply it, answer nothing (#8553), or ignore it. */
  errorFilter: 'honors' | 'empty' | 'ignores' = 'ignores',
) => {
  const requests: Array<{
    size: number;
    bound: string | undefined;
    serverFiltered: boolean;
  }> = [];
  const fetchPage = (request: {
    readonly resume?: PageResume;
    readonly size: number;
    readonly serverFiltered: boolean;
  }) => {
    const bound = request.resume?.before;
    requests.push({
      size: request.size,
      bound,
      serverFiltered: request.serverFiltered,
    });
    const asked = traceFetchSize(request.size, request.resume);
    const candidates = store
      .filter(
        (candidate) =>
          bound === undefined ||
          nanoToIso(candidate.startTimeUnixNano) <= bound,
      )
      .filter((candidate) => {
        if (!request.serverFiltered || errorFilter === 'ignores') return true;
        return errorFilter === 'honors' && (candidate.errorSpanCount ?? 0) > 0;
      })
      .sort((left, right) =>
        right.startTimeUnixNano.localeCompare(left.startTimeUnixNano),
      )
      .slice(0, asked)
      .reverse();
    return Effect.succeed(
      pageTraces({
        summaries: candidates,
        limit: request.size,
        resume: request.resume,
      }),
    );
  };
  return { fetchPage, requests };
};

const ids = (rows: ReadonlyArray<TraceSummary>) =>
  rows.map((row) => row.traceId);

describe('pageTraces', () => {
  const store = Array.from({ length: 7 }, (_, index) => summary(index, 0));

  test('pages newest to oldest without gaps or repeats', async () => {
    const jaeger = fakeJaeger(store);
    const seen: Array<string> = [];
    const loop = async (resume?: PageResume): Promise<void> => {
      const page = await Effect.runPromise(
        jaeger.fetchPage({ resume, size: 3 }),
      );
      seen.push(...ids(page.kept).reverse());
      if (page.next !== undefined) await loop(page.next);
    };
    await loop();
    expect(seen).toEqual(ids(store).reverse());
  });

  test('traces sharing a start time are not lost or repeated at a page boundary', async () => {
    const twins = [
      summary(1, 0),
      summary(2, 0),
      { ...summary(3, 0), traceId: 'twin-a' },
      { ...summary(3, 0), traceId: 'twin-b' },
      summary(4, 0),
    ];
    const jaeger = fakeJaeger(twins);
    const first = await Effect.runPromise(jaeger.fetchPage({ size: 2 }));
    expect(first.next?.before).toBe(
      nanoToIso(twins[2]?.startTimeUnixNano ?? ''),
    );
    expect(first.next?.seen).toHaveLength(1);
    const second = await Effect.runPromise(
      jaeger.fetchPage({ resume: first.next, size: 2 }),
    );
    const third = second.next
      ? await Effect.runPromise(
          jaeger.fetchPage({ resume: second.next, size: 2 }),
        )
      : { kept: [] };
    const all = [...first.kept, ...second.kept, ...third.kept];
    expect(ids(all).sort()).toEqual(ids(twins).sort());
  });

  test('duplicate trace ids within a response collapse', () => {
    const page = pageTraces({
      summaries: [summary(1, 0), summary(1, 0), summary(2, 0)],
      limit: 5,
    });
    expect(ids(page.kept)).toEqual(['t0001', 't0002']);
    expect(page.next).toBeUndefined();
  });
});

describe('trace cursor', () => {
  test('round-trips through the shared encoding and rejects other kinds', async () => {
    const since = new Date('2026-10-12T00:00:00.000Z');
    const cursor = toTraceCursor(since, {
      before: '2026-10-12T00:25:58.664085257Z',
      seen: ['abc'],
    });
    const decoded = await Effect.runPromise(decodeCursor(encodeCursor(cursor)));
    const resumed = await Effect.runPromise(fromTraceCursor(decoded));
    expect(resumed.since).toEqual(since);
    expect(resumed.mode).toBeUndefined();
    expect(resumed.resume).toEqual({
      before: '2026-10-12T00:25:58.664085257Z',
      seen: ['abc'],
    });
    const wrong = await Effect.runPromise(
      fromTraceCursor({ kind: 'railway-relay', after: 'x' }).pipe(
        Effect.result,
      ),
    );
    expect(wrong._tag).toBe('Failure');
  });

  test('carries the scan mode', async () => {
    const next = { before: '2026-10-12T00:25:58.664085257Z', seen: [] };
    for (const mode of ['filtered', 'client'] as const) {
      const decoded = await Effect.runPromise(
        decodeCursor(
          encodeCursor(toTraceCursor(new Date('2026-10-12'), next, mode)),
        ),
      );
      expect((await Effect.runPromise(fromTraceCursor(decoded))).mode).toBe(
        mode,
      );
    }
  });
});

describe('scanErrorTraces', () => {
  const scan = (
    store: ReadonlyArray<TraceSummary>,
    options: {
      limit: number;
      scanCap?: number;
      pageSize?: number;
      resume?: PageResume;
      errorFilter?: 'honors' | 'empty' | 'ignores';
      mode?: ErrorScanMode;
    },
  ) => {
    const jaeger = fakeJaeger(store, options.errorFilter);
    return {
      jaeger,
      run: Effect.runPromise(
        scanErrorTraces({
          limit: options.limit,
          scanCap: options.scanCap ?? 1000,
          pageSize: options.pageSize ?? 4,
          resume: options.resume,
          mode: options.mode,
          fetchPage: jaeger.fetchPage,
        }),
      ),
    };
  };

  // Errors at 2, 5, 6, 9; 12 traces in all.
  const store = Array.from({ length: 12 }, (_, index) =>
    summary(index, [2, 5, 6, 9].includes(index) ? 1 : 0),
  );

  test('stops after limit matches, newest first, and resumes right after the last one', async () => {
    const first = await scan(store, { limit: 2 }).run;
    expect(ids(first.matches)).toEqual(['t0006', 't0009']);
    expect(first.capped).toBe(false);
    expect(first.next).toBeDefined();

    const second = await scan(store, { limit: 2, resume: first.next }).run;
    expect(ids(second.matches)).toEqual(['t0002', 't0005']);
    // Older traces remain unread, so the cursor stays; following it finds nothing.
    const third = await scan(store, { limit: 2, resume: second.next }).run;
    expect(third.matches).toEqual([]);
    expect(third.next).toBeUndefined();
  });

  test('reads the whole window when fewer than limit match', async () => {
    const result = await scan(store, { limit: 10 }).run;
    expect(ids(result.matches)).toEqual(['t0002', 't0005', 't0006', 't0009']);
    expect(result.next).toBeUndefined();
    expect(result.capped).toBe(false);
    expect(result.scanned).toBe(12);
  });

  test('stops at the scan cap with a cursor into the unread rest', async () => {
    const result = await scan(store, { limit: 10, scanCap: 8 }).run;
    expect(result.scanned).toBe(8);
    expect(result.capped).toBe(true);
    expect(ids(result.matches)).toEqual(['t0005', 't0006', 't0009']);
    expect(result.next).toBeDefined();
    const rest = await scan(store, { limit: 10, resume: result.next }).run;
    expect(ids(rest.matches)).toEqual(['t0002']);
  });

  test('the cap does not trip when the window ends exactly there', async () => {
    const result = await scan(store, { limit: 10, scanCap: 12 }).run;
    expect(result.capped).toBe(false);
    expect(result.next).toBeUndefined();
  });

  test('a limit hit on the last matching trace of a drained window has no cursor', async () => {
    const result = await scan(store, { limit: 4, pageSize: 20 }).run;
    expect(ids(result.matches)).toHaveLength(4);
    expect(result.next).toBeUndefined();
  });

  test('asks Jaeger to filter first, so errors beyond the scan cap are found', async () => {
    const result = await scan(store, {
      limit: 10,
      scanCap: 4,
      errorFilter: 'honors',
    }).run;
    expect(ids(result.matches)).toEqual(['t0002', 't0005', 't0006', 't0009']);
    expect(result.capped).toBe(false);
    expect(result.next).toBeUndefined();
  });

  test('falls back to the client scan when the filtered search returns nothing', async () => {
    const run = scan(store, { limit: 10, errorFilter: 'empty' });
    const result = await run.run;
    expect(ids(result.matches)).toEqual(['t0002', 't0005', 't0006', 't0009']);
    expect(result.scanned).toBe(12);
    expect(
      run.jaeger.requests.map((request) => request.serverFiltered),
    ).toEqual([true, false, false, false]);
  });

  test('reports the mode that produced the cursor', async () => {
    const honored = await scan(store, {
      limit: 1,
      errorFilter: 'honors',
    }).run;
    expect(honored.mode).toBe('filtered');
    expect(honored.next).toBeDefined();
    const fellBack = await scan(store, {
      limit: 1,
      errorFilter: 'empty',
    }).run;
    expect(fellBack.mode).toBe('client');
    expect(fellBack.next).toBeDefined();
  });

  test('a resumed filtered page that comes back empty does not fall back', async () => {
    const run = scan(store, {
      limit: 10,
      errorFilter: 'empty',
      mode: 'filtered',
      resume: {
        before: nanoToIso(store[1]?.startTimeUnixNano ?? ''),
        seen: [],
      },
    });
    const result = await run.run;
    expect(result.matches).toEqual([]);
    expect(result.mode).toBe('filtered');
    expect(run.jaeger.requests).toHaveLength(1);
  });

  test('a resumed client page never asks Jaeger to filter', async () => {
    const run = scan(store, {
      limit: 10,
      errorFilter: 'honors',
      mode: 'client',
    });
    const result = await run.run;
    expect(ids(result.matches)).toEqual(['t0002', 't0005', 't0006', 't0009']);
    expect(result.mode).toBe('client');
    expect(run.jaeger.requests.some((request) => request.serverFiltered)).toBe(
      false,
    );
  });

  test('a filter Jaeger ignores is not scanned twice', async () => {
    const run = scan(store, { limit: 10, errorFilter: 'ignores' });
    const result = await run.run;
    expect(ids(result.matches)).toEqual(['t0002', 't0005', 't0006', 't0009']);
    expect(run.jaeger.requests.every((request) => request.serverFiltered)).toBe(
      true,
    );
  });

  describe('without the legacy search endpoint', () => {
    const unavailable = new TraceAttributeSearchUnavailable({
      status: 404,
      url: 'https://host.example/api/traces',
    });

    test.each([
      404, 405,
    ])('a %d on the filtered pass degrades to the client scan', async (status) => {
      const jaeger = fakeJaeger(store);
      const requests: Array<boolean> = [];
      const result = await Effect.runPromise(
        scanErrorTraces({
          limit: 10,
          scanCap: 1000,
          pageSize: 4,
          fetchPage: (request) => {
            requests.push(request.serverFiltered);
            return request.serverFiltered
              ? Effect.fail(
                  new TraceAttributeSearchUnavailable({
                    status,
                    url: unavailable.url,
                  }),
                )
              : jaeger.fetchPage(request);
          },
        }),
      );
      expect(ids(result.matches)).toEqual(['t0002', 't0005', 't0006', 't0009']);
      expect(result.mode).toBe('client');
      expect(requests).toEqual([true, false, false, false]);
    });

    test('a caller attribute filter still fails, because the client scan needs the same endpoint', async () => {
      const requests: Array<boolean> = [];
      const error = await Effect.runPromise(
        scanErrorTraces({
          limit: 10,
          scanCap: 1000,
          pageSize: 4,
          fetchPage: (request) => {
            requests.push(request.serverFiltered);
            return Effect.fail(unavailable);
          },
        }).pipe(Effect.flip),
      );
      expect(error).toBe(unavailable);
      expect(requests).toEqual([true, false]);
    });
  });

  test('still verifies server matches against the summary error count', async () => {
    const result = await scan([summary(1, 0), summary(2, 0)], {
      limit: 5,
      errorFilter: 'honors',
    }).run;
    expect(result.matches).toEqual([]);
  });

  test('fails when the backend reports no error counts', async () => {
    const result = await Effect.runPromise(
      scanErrorTraces({
        limit: 2,
        scanCap: 100,
        pageSize: 10,
        fetchPage: fakeJaeger([summary(1, undefined)]).fetchPage,
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('TraceErrorCountsUnavailable');
    }
  });
});

describe('errorSearchAttributes', () => {
  test('adds the error filter only to server-filtered passes and keeps the caller attributes', () => {
    expect(errorSearchAttributes(false, undefined)).toBeUndefined();
    expect(errorSearchAttributes(false, { a: 'b' })).toEqual({ a: 'b' });
    expect(errorSearchAttributes(true, undefined)).toEqual({ error: 'true' });
    expect(errorSearchAttributes(true, { a: 'b' })).toEqual({
      a: 'b',
      error: 'true',
    });
  });
});

describe('toTraceRow', () => {
  test('maps a summary with a lossless ISO start and service names', () => {
    const row = toTraceRow({
      ...summary(5, 2),
      startTimeUnixNano: '1791800000123456789',
      services: [
        { name: 'web', spanCount: 2 },
        { name: 'engine', spanCount: 1 },
      ],
    });
    expect(row).toEqual({
      traceId: 't0005',
      rootService: 'web',
      rootOperation: 'GET /',
      startTs: '2026-10-12T10:13:20.123456789Z',
      durationMs: 10,
      spanCount: 3,
      errorSpanCount: 2,
      services: ['web', 'engine'],
    });
  });

  test('leaves errorSpanCount out when the backend did not report it', () => {
    expect('errorSpanCount' in toTraceRow(summary(1, undefined))).toBe(false);
  });
});
