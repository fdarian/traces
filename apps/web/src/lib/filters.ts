import * as S from 'effect/Schema';

const RangePresetSchema = S.Literal('15m', '1h', '6h', '24h', '7d');

export type RangePreset = typeof RangePresetSchema.Type;

export type RangeValue =
  | RangePreset
  | { readonly from: string; readonly to: string };

export const GlobalFilterSchema = S.Struct({
  service: S.optional(S.Union(S.String, S.Array(S.String))),
  range: S.optional(S.Union(RangePresetSchema, S.Literal('custom'))),
  from: S.optional(S.String),
  to: S.optional(S.String),
});

export type RawGlobalFilters = typeof GlobalFilterSchema.Type;

export function normalizeGlobalFilters(raw: RawGlobalFilters): {
  readonly service: ReadonlyArray<string>;
  readonly range: RangeValue | null;
} {
  const service = (() => {
    const s = raw.service;
    if (s === undefined) return [];
    if (typeof s === 'string') return [s];
    return s;
  })();

  const range = ((): RangeValue | null => {
    const r = raw.range;
    if (r === undefined) return null;
    if (r === 'custom') {
      const from = raw.from;
      const to = raw.to;
      if (from !== undefined && to !== undefined) {
        return { from, to };
      }
      return null;
    }
    return r;
  })();

  return { service, range };
}

export const TraceFilterSchema = S.Struct({
  operation: S.optional(S.String),
  status: S.optional(S.Literal('all', 'errors-only')),
  minDuration: S.optional(S.String),
  maxDuration: S.optional(S.String),
  attributes: S.optional(S.String),
});

export type RawTraceFilters = typeof TraceFilterSchema.Type;

export function normalizeTraceFilters(raw: RawTraceFilters): {
  readonly operation: string | undefined;
  readonly status: 'all' | 'errors-only';
  readonly minDuration: string | undefined;
  readonly maxDuration: string | undefined;
  readonly attributes: string | undefined;
} {
  return {
    operation: raw.operation,
    status: raw.status ?? 'all',
    minDuration: raw.minDuration,
    maxDuration: raw.maxDuration,
    attributes: raw.attributes,
  };
}

export function computeTimeRange(range: RangeValue | null): {
  readonly startTimeMin: string;
  readonly startTimeMax: string;
} {
  const now = new Date();
  const startTimeMax = now.toISOString();
  if (range === null) {
    const startTimeMin = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    return { startTimeMin, startTimeMax };
  }
  if (typeof range === 'object') {
    return { startTimeMin: range.from, startTimeMax: range.to };
  }
  const minutes = (() => {
    switch (range) {
      case '15m':
        return 15;
      case '1h':
        return 60;
      case '6h':
        return 6 * 60;
      case '24h':
        return 24 * 60;
      case '7d':
        return 7 * 24 * 60;
      default:
        return 60;
    }
  })();
  const startTimeMin = new Date(
    now.getTime() - minutes * 60 * 1000,
  ).toISOString();
  return { startTimeMin, startTimeMax };
}

export function parseAttributes(
  input: string | undefined,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  const result: Record<string, string> = {};
  const pairs = input.split(',');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key.length > 0 && value.length > 0) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
