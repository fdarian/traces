import { Schema } from 'effect';
import type { AttributeValue, Span, Trace } from '../model.js';
import { extractExceptionInfo, nanoToIso } from '../normalize.js';

const SpanEventRow = Schema.Struct({
  name: Schema.String,
  /** ISO timestamp, millisecond precision (the backend model keeps event times in ms). */
  ts: Schema.String,
  attrs: Schema.Record(Schema.String, Schema.Unknown),
});

const SpanException = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  stacktrace: Schema.optional(Schema.String),
});

const SPAN_KINDS = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
] as const;
const SpanKind = Schema.Literals(SPAN_KINDS);
export type SpanKind = typeof SpanKind.Type;

/** OTLP-JSON carries the kind as an enum number or a `SPAN_KIND_*` string, depending on the exporter. */
export const normalizeSpanKind = (raw: string): SpanKind => {
  if (/^\d+$/.test(raw)) return SPAN_KINDS[Number(raw)] ?? 'unspecified';
  const name = raw.replace(/^SPAN_KIND_/i, '').toLowerCase();
  return SPAN_KINDS.find((kind) => kind === name) ?? 'unspecified';
};

export const SpanRow = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  /** Present for orphans too: it names the span that is missing from the trace. */
  parentSpanId: Schema.optional(Schema.String),
  depth: Schema.Number,
  service: Schema.String,
  name: Schema.String,
  kind: SpanKind,
  /** ISO timestamp with nanosecond precision. */
  startTs: Schema.String,
  durationMs: Schema.Number,
  status: Schema.Literals(['ok', 'error', 'unset']),
  statusMessage: Schema.optional(Schema.String),
  attrs: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(SpanEventRow),
  /** Moved out of the first exception event, so `events` does not repeat the stacktrace; later exception events stay. */
  exception: Schema.optional(SpanException),
});
export type SpanRow = typeof SpanRow.Type;

const toRecord = (attributes: ReadonlyArray<AttributeValue>) =>
  Object.fromEntries(
    attributes.map((attribute) => [attribute.key, attribute.value]),
  );

const toSpanRow = (span: Span, depth: number): SpanRow => {
  const exception = extractExceptionInfo(span.events)[0];
  const promotedIndex = span.events.findIndex(
    (event) => event.name === 'exception',
  );
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined || span.parentSpanId === ''
      ? {}
      : { parentSpanId: span.parentSpanId }),
    depth,
    service: span.resource.serviceName,
    name: span.name,
    kind: normalizeSpanKind(span.kind),
    startTs: nanoToIso(span.startTimeUnixNano),
    durationMs: span.durationMs,
    status: span.status.code,
    ...(span.status.message === undefined || span.status.message === ''
      ? {}
      : { statusMessage: span.status.message }),
    attrs: toRecord(span.attributes),
    events: span.events
      .filter((_, index) => index !== promotedIndex)
      .map((event) => ({
        name: event.name,
        ts: new Date(event.timestamp).toISOString(),
        attrs: toRecord(event.attributes),
      })),
    ...(exception === undefined
      ? {}
      : {
          exception: {
            type: exception.type,
            message: exception.message,
            ...(exception.stacktrace === ''
              ? {}
              : { stacktrace: exception.stacktrace }),
          },
        }),
  };
};

const byStart = (left: Span, right: Span): number => {
  const delta =
    BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano);
  if (delta !== 0n) return delta < 0n ? -1 : 1;
  return left.spanId.localeCompare(right.spanId);
};

/**
 * Depth-first rows, children by start time. A span whose parent is not in the
 * trace is a root, so a partially retained trace still renders.
 */
export const toSpanRows = (trace: Trace): ReadonlyArray<SpanRow> => {
  const known = new Set(trace.spans.map((span) => span.spanId));
  const children = new Map<string, Array<Span>>();
  const roots: Array<Span> = [];
  for (const span of trace.spans) {
    const parent = span.parentSpanId;
    if (parent === undefined || parent === '' || !known.has(parent)) {
      roots.push(span);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }

  const rows: Array<SpanRow> = [];
  const visited = new Set<string>();
  const visit = (span: Span, depth: number) => {
    if (visited.has(span.spanId)) return;
    visited.add(span.spanId);
    rows.push(toSpanRow(span, depth));
    for (const child of (children.get(span.spanId) ?? []).sort(byStart)) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots.sort(byStart)) visit(root, 0);
  // Spans whose parents form a cycle are unreachable from any root; keep them rather than drop data.
  for (const span of [...trace.spans].sort(byStart)) visit(span, 0);
  return rows;
};
