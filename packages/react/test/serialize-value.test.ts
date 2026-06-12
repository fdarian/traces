import { describe, expect, test } from 'bun:test';
import { serializeAttribute, serializeValue } from '@traces/core';

describe('serializeValue', () => {
  test('returns undefined for undefined input instead of the string "undefined"', () => {
    expect(serializeValue(undefined)).toBeUndefined();
  });

  test('preserves null', () => {
    expect(serializeValue(null)).toBeNull();
  });
});

describe('serializeAttribute', () => {
  test('omits attributes whose normalized value is undefined', () => {
    expect(
      serializeAttribute({
        key: 'missing',
        value: undefined,
      }),
    ).toBeNull();
  });
});
