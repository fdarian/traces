import { describe, expect, test } from 'bun:test';
import {
  buildIssueTitle,
  fingerprintFromErrorSpan,
  fingerprintFromException,
  hashFingerprint,
} from '#/issues/fingerprint.js';
import { normalizeExceptionMessage } from '#/issues/normalize-message.js';
import { parseTopInAppStackFrame } from '#/issues/stack-frame.js';
import type { Span } from '#/model.js';

const SEED_EXCEPTIONS = [
  {
    type: 'DatabaseConnectionError',
    message: 'connection refused to postgres:5432',
    stacktrace:
      'DatabaseConnectionError: connection refused to postgres:5432\n    at select (/app/db/src/index.ts:42:15)',
  },
  {
    type: 'PaymentGatewayError',
    message: 'stripe returned 402 card declined',
    stacktrace:
      'PaymentGatewayError: stripe returned 402 card declined\n    at chargeCard (/app/payments/src/index.ts:88:10)',
  },
  {
    type: 'NullPointerException',
    message: 'cannot read property of undefined at line 42',
    stacktrace:
      'NullPointerException: cannot read property of undefined at line 42\n    at getUser (/app/api/src/index.ts:120:8)',
  },
  {
    type: 'ValidationError',
    message: 'field email is required',
    stacktrace:
      'ValidationError: field email is required\n    at processCheckout (/app/api/src/index.ts:55:4)',
  },
  {
    type: 'TimeoutError',
    message: 'request timed out after 30000ms',
    stacktrace:
      'TimeoutError: request timed out after 30000ms\n    at verify3DS (/app/payments/src/index.ts:14:2)',
  },
];

describe('normalizeExceptionMessage', () => {
  const cases: Array<{ input: string; expected: string }> = [
    {
      input: 'connection refused to postgres:5432',
      expected: 'connection refused to postgres:<NUM>',
    },
    {
      input: 'request timed out after 30000ms',
      expected: 'request timed out after <NUM>ms',
    },
    {
      input: 'trace 8f14e45f-ceea-467f-a0fc-59dccf7757c7 failed',
      expected: 'trace <UUID> failed',
    },
    {
      input: 'id 0xdeadbeef and abcdef0123456789',
      expected: 'id <HEX> and <HEX>',
    },
    {
      input: 'value "dynamic" and \'quoted\'',
      expected: 'value <STR> and <STR>',
    },
  ];

  for (const testCase of cases) {
    test(`normalizes ${testCase.input}`, () => {
      expect(normalizeExceptionMessage(testCase.input)).toBe(testCase.expected);
    });
  }
});

describe('parseTopInAppStackFrame', () => {
  test('extracts first in-app frame from seed stacktrace', () => {
    const frame = parseTopInAppStackFrame(SEED_EXCEPTIONS[0].stacktrace);
    expect(frame).toBe('/app/db/src/index.ts:<NUM>:<NUM>');
  });

  test('skips node_modules frames', () => {
    const stacktrace =
      'Error: boom\n    at fn (/app/node_modules/pkg/index.js:1:1)\n    at run (/app/api/src/index.ts:10:5)';
    const frame = parseTopInAppStackFrame(stacktrace);
    expect(frame).toBe('/app/api/src/index.ts:<NUM>:<NUM>');
  });

  test('returns null for empty stacktrace', () => {
    expect(parseTopInAppStackFrame('')).toBeNull();
  });

  test('parses indented bare at frame without parentheses', () => {
    const stacktrace = 'Error: boom\n    at /app/foo.ts:1:2';
    const frame = parseTopInAppStackFrame(stacktrace);
    expect(frame).toBe('/app/foo.ts:<NUM>:<NUM>');
  });
});

describe('fingerprintFromException', () => {
  test('same exception shape produces stable fingerprint', () => {
    const first = fingerprintFromException('db', SEED_EXCEPTIONS[0]);
    const second = fingerprintFromException('db', {
      type: SEED_EXCEPTIONS[0].type,
      message: 'connection refused to postgres:9999',
      stacktrace:
        'DatabaseConnectionError: connection refused to postgres:9999\n    at select (/app/db/src/index.ts:99:22)',
    });
    expect(first).toBe(second);
  });

  test('different services produce different fingerprints', () => {
    const db = fingerprintFromException('db', SEED_EXCEPTIONS[0]);
    const api = fingerprintFromException('api', SEED_EXCEPTIONS[0]);
    expect(db).not.toBe(api);
  });

  test('different exception types produce different fingerprints', () => {
    const first = fingerprintFromException('api', SEED_EXCEPTIONS[2]);
    const second = fingerprintFromException('api', SEED_EXCEPTIONS[3]);
    expect(first).not.toBe(second);
  });
});

describe('fingerprintFromErrorSpan', () => {
  const baseSpan: Span = {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'processCheckout',
    kind: 'internal',
    startTimeUnixNano: '1000000000',
    endTimeUnixNano: '2000000000',
    durationMs: 1,
    status: { code: 'error', message: 'checkout failed for user 12345' },
    attributes: [],
    events: [],
    resource: {
      serviceName: 'api',
      attributes: [],
    },
  };

  test('fingerprints error span without exception event', () => {
    const fingerprint = fingerprintFromErrorSpan(baseSpan);
    expect(fingerprint).toBe(
      hashFingerprint([
        'api',
        'processCheckout',
        'checkout failed for user <NUM>',
      ]),
    );
  });

  test('omits status message when absent', () => {
    const span: Span = {
      ...baseSpan,
      status: { code: 'error' },
    };
    const fingerprint = fingerprintFromErrorSpan(span);
    expect(fingerprint).toBe(hashFingerprint(['api', 'processCheckout']));
  });
});

describe('buildIssueTitle', () => {
  test('condenses long messages', () => {
    const longMessage = 'x'.repeat(120);
    const title = buildIssueTitle('TimeoutError', longMessage);
    expect(title.startsWith('TimeoutError: ')).toBe(true);
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBeLessThan(110);
  });
});
