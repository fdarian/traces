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
