import { expect, test } from 'bun:test';
import { parseExcludedServices } from '#/issues/excluded-services';

test('splits on commas, trims, and drops empty entries', () => {
  expect(parseExcludedServices(' jaeger, web ,,db ')).toEqual(
    new Set(['jaeger', 'web', 'db']),
  );
});

test('none excludes nothing', () => {
  expect(parseExcludedServices('none').size).toBe(0);
  expect(parseExcludedServices(' none ').size).toBe(0);
});
