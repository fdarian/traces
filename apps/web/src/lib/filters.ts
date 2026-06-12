import * as v from 'valibot';

const RangePresetSchema = v.picklist(['15m', '1h', '6h', '24h', '7d']);

export type RangePreset = v.InferOutput<typeof RangePresetSchema>;

export type RangeValue =
  | RangePreset
  | { readonly from: string; readonly to: string };

export const GlobalFilterSchema = v.object({
  service: v.optional(v.union([v.string(), v.array(v.string())])),
  range: v.optional(v.union([RangePresetSchema, v.literal('custom')])),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
});

export type RawGlobalFilters = v.InferOutput<typeof GlobalFilterSchema>;

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
