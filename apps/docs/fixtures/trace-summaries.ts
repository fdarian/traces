import type { TraceSummary } from '@traces/react';

export const sampleTraceSummaries: TraceSummary[] = [
  {
    traceId: '5a09233a69f976d42e9807c3164e7de1',
    rootService: 'web',
    rootOperation: 'GET /dashboard',
    spanCount: 4,
    errorSpanCount: 0,
    startTimeUnixNano: '1700000000000000000',
    durationMs: 142,
    services: [
      { name: 'web', spanCount: 2 },
      { name: 'db', spanCount: 2 },
    ],
  },
  {
    traceId: 'ca30626a4281b50cae64c3dfe4d09569',
    rootService: 'web',
    rootOperation: 'POST /api/checkout',
    spanCount: 7,
    errorSpanCount: 1,
    startTimeUnixNano: '1700000001000000000',
    durationMs: 384,
    services: [
      { name: 'web', spanCount: 3 },
      { name: 'payments', spanCount: 2 },
      { name: 'db', spanCount: 2 },
    ],
  },
  {
    traceId: 'd80003b36463581f7695696c9f635a15',
    rootService: 'api',
    rootOperation: 'GET /api/users',
    spanCount: 3,
    errorSpanCount: 0,
    startTimeUnixNano: '1700000002000000000',
    durationMs: 67,
    services: [
      { name: 'api', spanCount: 2 },
      { name: 'db', spanCount: 1 },
    ],
  },
  {
    traceId: '736e9242e4f1872c92235e070f817fdd',
    rootService: 'worker',
    rootOperation: 'process.job',
    spanCount: 5,
    errorSpanCount: 0,
    startTimeUnixNano: '1700000003000000000',
    durationMs: 910,
    services: [
      { name: 'worker', spanCount: 3 },
      { name: 'db', spanCount: 2 },
    ],
  },
];
