import { expect, test } from 'bun:test';
import { contract } from '@traces/contract';

const procedureNames = {
  traces: ['listServices', 'listOperations', 'search', 'get'],
  issues: ['list', 'get', 'resolve', 'unresolve'],
  home: [
    'stats',
    'trend',
    'topIssues',
    'errorRate',
    'serviceHealth',
    'recentErrorTraces',
  ],
} as const;

test('contract exposes all 14 procedures', () => {
  expect(Object.keys(contract).sort()).toEqual(['home', 'issues', 'traces']);
  let count = 0;
  for (const domain of Object.keys(procedureNames) as Array<
    keyof typeof procedureNames
  >) {
    expect(Object.keys(contract[domain]).sort()).toEqual(
      [...procedureNames[domain]].sort(),
    );
    count += procedureNames[domain].length;
  }
  expect(count).toBe(14);
});

test('traces.get declares jaeger and not-found errors', () => {
  const errorMap = contract.traces.get['~orpc'].errorMap;
  expect(Object.keys(errorMap).sort()).toEqual([
    'JAEGER_BAD_RESPONSE',
    'JAEGER_UNAUTHORIZED',
    'JAEGER_UNREACHABLE',
    'TRACE_NOT_FOUND',
  ]);
  expect(errorMap.TRACE_NOT_FOUND?.status).toBe(404);
});
