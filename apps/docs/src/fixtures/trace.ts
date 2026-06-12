import type { Trace } from '@traces/react';

export const sampleTrace: Trace = {
  traceId: 'abc123def45678901234567890abcdef',
  spans: [
    {
      traceId: 'abc123def45678901234567890abcdef',
      spanId: 'span001',
      name: 'GET /api/users',
      kind: 'SERVER',
      startTimeUnixNano: '1700000000000000000',
      endTimeUnixNano: '1700000000600000000',
      durationMs: 600,
      status: { code: 'ok' },
      attributes: [
        { key: 'http.method', value: 'GET' },
        { key: 'http.status_code', value: 200 },
      ],
      events: [],
      resource: {
        serviceName: 'web',
        attributes: [{ key: 'service.name', value: 'web' }],
      },
    },
    {
      traceId: 'abc123def45678901234567890abcdef',
      spanId: 'span002',
      parentSpanId: 'span001',
      name: 'db.query',
      kind: 'CLIENT',
      startTimeUnixNano: '1700000000100000000',
      endTimeUnixNano: '1700000000500000000',
      durationMs: 400,
      status: { code: 'error', message: 'connection refused to postgres:5432' },
      attributes: [
        { key: 'db.statement', value: 'SELECT * FROM users WHERE id = ?' },
      ],
      events: [
        {
          name: 'exception',
          timestamp: 1700000000200,
          attributes: [
            { key: 'exception.type', value: 'DatabaseConnectionError' },
            {
              key: 'exception.message',
              value: 'connection refused to postgres:5432',
            },
            {
              key: 'exception.stacktrace',
              value:
                'DatabaseConnectionError: connection refused\n    at db.query (/app/db.ts:42:10)\n    at handler (/app/routes/users.ts:18:5)',
            },
          ],
        },
      ],
      resource: {
        serviceName: 'web',
        attributes: [{ key: 'service.name', value: 'web' }],
      },
    },
    {
      traceId: 'abc123def45678901234567890abcdef',
      spanId: 'span003',
      parentSpanId: 'span002',
      name: 'db.connection',
      kind: 'INTERNAL',
      startTimeUnixNano: '1700000000150000000',
      endTimeUnixNano: '1700000000400000000',
      durationMs: 250,
      status: { code: 'unset' },
      attributes: [],
      events: [],
      resource: {
        serviceName: 'db',
        attributes: [{ key: 'service.name', value: 'db' }],
      },
    },
  ],
};
