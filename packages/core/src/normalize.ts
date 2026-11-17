import type {
  AttributeValue,
  ExceptionInfo,
  SpanEvent,
  StatusCode,
} from './model.js';

export function normalizeTimestamp(value: string | number): string {
  if (typeof value === 'string') {
    return value;
  }
  return value.toString();
}

export function normalizeTimestampToMs(value: string | number): number {
  const nanoStr = typeof value === 'string' ? value : value.toString();
  const nanos = BigInt(nanoStr);
  return Number(nanos / BigInt(1000000));
}

export function normalizeDurationMs(
  start: string | number,
  end: string | number,
): number {
  return nanosToMs(BigInt(end) - BigInt(start));
}

export function nanosToMs(nanos: bigint): number {
  return Number(nanos) / 1_000_000;
}

export function normalizeAttributeValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    return raw;
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;

    if (obj.stringValue !== undefined) {
      return obj.stringValue;
    }

    if (obj.intValue !== undefined) {
      return Number(obj.intValue);
    }

    if (obj.boolValue !== undefined) {
      return Boolean(obj.boolValue);
    }

    if (obj.doubleValue !== undefined) {
      return Number(obj.doubleValue);
    }

    if (Array.isArray(obj.arrayValue)) {
      return obj.arrayValue.map(normalizeAttributeValue);
    }

    if (obj.arrayValue !== undefined && typeof obj.arrayValue === 'object') {
      const arrVal = obj.arrayValue as Record<string, unknown>;
      if (Array.isArray(arrVal.values)) {
        return arrVal.values.map(normalizeAttributeValue);
      }
    }

    if (obj.kvlistValue !== undefined && typeof obj.kvlistValue === 'object') {
      const kv = obj.kvlistValue as Record<string, unknown>;
      if (Array.isArray(kv.values)) {
        const values = kv.values as Array<Record<string, unknown>>;
        const result: Record<string, unknown> = {};
        for (const entry of values) {
          if (entry.key !== undefined && entry.value !== undefined) {
            result[String(entry.key)] = normalizeAttributeValue(entry.value);
          }
        }
        return result;
      }
    }
  }

  return raw;
}

export function normalizeAttribute(
  raw: Record<string, unknown>,
): AttributeValue {
  return {
    key: String(raw.key),
    value: normalizeAttributeValue(raw.value),
  };
}

export function normalizeAttributes(
  raw: unknown,
): ReadonlyArray<AttributeValue> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => normalizeAttribute(item as Record<string, unknown>));
}

export function normalizeStatusCode(code: unknown): StatusCode {
  if (code === 0 || code === 'STATUS_CODE_UNSET' || code === 'unset') {
    return 'unset';
  }
  if (code === 1 || code === 'STATUS_CODE_OK' || code === 'ok') {
    return 'ok';
  }
  if (code === 2 || code === 'STATUS_CODE_ERROR' || code === 'error') {
    return 'error';
  }
  return 'unset';
}

export function normalizeSpanEvent(raw: Record<string, unknown>): SpanEvent {
  return {
    name: String(raw.name),
    timestamp: normalizeTimestampToMs(raw.timeUnixNano as string | number),
    attributes: normalizeAttributes(raw.attributes),
  };
}

export function normalizeSpanEvents(raw: unknown): ReadonlyArray<SpanEvent> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => normalizeSpanEvent(item as Record<string, unknown>));
}

export function extractExceptionInfo(
  events: ReadonlyArray<SpanEvent>,
): ReadonlyArray<ExceptionInfo> {
  const result: Array<ExceptionInfo> = [];
  for (const event of events) {
    if (event.name !== 'exception') {
      continue;
    }
    let type = '';
    let message = '';
    let stacktrace = '';
    for (const attr of event.attributes) {
      if (attr.key === 'exception.type') {
        type = String(attr.value);
      }
      if (attr.key === 'exception.message') {
        message = String(attr.value);
      }
      if (attr.key === 'exception.stacktrace') {
        stacktrace = String(attr.value);
      }
    }
    result.push({ type, message, stacktrace });
  }
  return result;
}
