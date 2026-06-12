import { describe, expect, test } from 'bun:test';
import {
  extractExceptionInfo,
  normalizeAttribute,
  normalizeAttributes,
  normalizeAttributeValue,
  normalizeDurationMs,
  normalizeSpanEvent,
  normalizeSpanEvents,
  normalizeStatusCode,
  normalizeTimestamp,
  normalizeTimestampToMs,
} from '#/normalize.js';

describe('normalizeTimestamp', () => {
  test('returns string as-is', () => {
    expect(normalizeTimestamp('1700000000000000000')).toBe(
      '1700000000000000000',
    );
  });

  test('converts number to string', () => {
    expect(normalizeTimestamp(1700000000000000000)).toBe('1700000000000000000');
  });
});

describe('normalizeTimestampToMs', () => {
  test('converts nanoseconds to milliseconds', () => {
    expect(normalizeTimestampToMs('1700000000000000000')).toBe(1700000000000);
  });

  test('converts number nanoseconds to milliseconds', () => {
    expect(normalizeTimestampToMs(1700000000000000000)).toBe(1700000000000);
  });
});

describe('normalizeDurationMs', () => {
  test('computes duration from start to end', () => {
    expect(
      normalizeDurationMs('1700000000000000000', '1700000000600000000'),
    ).toBe(600);
  });
});

describe('normalizeAttributeValue', () => {
  test('extracts stringValue', () => {
    expect(normalizeAttributeValue({ stringValue: 'hello' })).toBe('hello');
  });

  test('extracts intValue from string', () => {
    expect(normalizeAttributeValue({ intValue: '42' })).toBe(42);
  });

  test('extracts intValue from number', () => {
    expect(normalizeAttributeValue({ intValue: 42 })).toBe(42);
  });

  test('extracts boolValue', () => {
    expect(normalizeAttributeValue({ boolValue: true })).toBe(true);
  });

  test('extracts doubleValue', () => {
    expect(normalizeAttributeValue({ doubleValue: 3.14 })).toBe(3.14);
  });

  test('extracts arrayValue values', () => {
    expect(
      normalizeAttributeValue({
        arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] },
      }),
    ).toEqual(['a', 'b']);
  });

  test('extracts kvlistValue as object', () => {
    expect(
      normalizeAttributeValue({
        kvlistValue: { values: [{ key: 'x', value: { stringValue: 'y' } }] },
      }),
    ).toEqual({ x: 'y' });
  });

  test('returns raw value for unknown shapes', () => {
    expect(normalizeAttributeValue(42)).toBe(42);
  });
});

describe('normalizeAttribute', () => {
  test('maps key and value', () => {
    const result = normalizeAttribute({
      key: 'test',
      value: { stringValue: 'hello' },
    });
    expect(result.key).toBe('test');
    expect(result.value).toBe('hello');
  });
});

describe('normalizeAttributes', () => {
  test('returns empty array for non-array input', () => {
    expect(normalizeAttributes(null)).toEqual([]);
    expect(normalizeAttributes(undefined)).toEqual([]);
  });

  test('normalizes array of attributes', () => {
    const result = normalizeAttributes([
      { key: 'a', value: { stringValue: '1' } },
      { key: 'b', value: { intValue: 2 } },
    ]);
    expect(result.length).toBe(2);
    expect(result[0].key).toBe('a');
    expect(result[0].value).toBe('1');
    expect(result[1].key).toBe('b');
    expect(result[1].value).toBe(2);
  });
});

describe('normalizeStatusCode', () => {
  test('returns unset for 0', () => {
    expect(normalizeStatusCode(0)).toBe('unset');
  });

  test('returns ok for 1', () => {
    expect(normalizeStatusCode(1)).toBe('ok');
  });

  test('returns error for 2', () => {
    expect(normalizeStatusCode(2)).toBe('error');
  });

  test('returns unset for unknown', () => {
    expect(normalizeStatusCode(99)).toBe('unset');
  });
});

describe('normalizeSpanEvent', () => {
  test('maps event with attributes', () => {
    const result = normalizeSpanEvent({
      name: 'exception',
      timeUnixNano: '1700000000100000000',
      attributes: [{ key: 'exception.type', value: { stringValue: 'Error' } }],
    });
    expect(result.name).toBe('exception');
    expect(result.timestamp).toBe(1700000000100);
    expect(result.attributes.length).toBe(1);
  });
});

describe('normalizeSpanEvents', () => {
  test('returns empty array for non-array input', () => {
    expect(normalizeSpanEvents(null)).toEqual([]);
  });

  test('normalizes array of events', () => {
    const result = normalizeSpanEvents([
      { name: 'start', timeUnixNano: '1000000000' },
      { name: 'end', timeUnixNano: '2000000000' },
    ]);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe('start');
    expect(result[1].name).toBe('end');
  });
});

describe('extractExceptionInfo', () => {
  test('extracts exception from events', () => {
    const events = [
      {
        name: 'exception',
        timestamp: 1000,
        attributes: [
          { key: 'exception.type', value: 'TypeError' },
          { key: 'exception.message', value: 'cannot read property' },
          { key: 'exception.stacktrace', value: 'at foo.ts:1:1' },
        ],
      },
      {
        name: 'other',
        timestamp: 2000,
        attributes: [],
      },
    ];
    const result = extractExceptionInfo(events);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('TypeError');
    expect(result[0].message).toBe('cannot read property');
    expect(result[0].stacktrace).toBe('at foo.ts:1:1');
  });
});
