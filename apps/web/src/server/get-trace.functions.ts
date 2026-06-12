import { createServerFn } from '@tanstack/react-start';
import type {
  AttributeValue,
  Span,
  SpanEvent,
  SpanResource,
  SpanStatus,
  Trace,
} from '@traces/core';
import {
  type SerializableAttributeValue,
  serializeAttribute,
  TraceBackend,
} from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const GetTraceInputSchema = S.Struct({
  traceId: S.String,
});

type SerializableSpanEvent = {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes: ReadonlyArray<SerializableAttributeValue>;
};

type SerializableSpanResource = {
  readonly serviceName: string;
  readonly attributes: ReadonlyArray<SerializableAttributeValue>;
};

type SerializableSpanStatus = {
  readonly code: SpanStatus['code'];
  readonly message?: string;
};

type SerializableSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly status: SerializableSpanStatus;
  readonly attributes: ReadonlyArray<SerializableAttributeValue>;
  readonly events: ReadonlyArray<SerializableSpanEvent>;
  readonly resource: SerializableSpanResource;
};

export type SerializableTrace = {
  readonly traceId: string;
  readonly spans: ReadonlyArray<SerializableSpan>;
};

export type GetTraceResult =
  | { readonly notFound: true; readonly traceId: string }
  | { readonly notFound: false; readonly trace: SerializableTrace };

function collectSerializedAttributes(
  attributes: ReadonlyArray<AttributeValue>,
): ReadonlyArray<SerializableAttributeValue> {
  const result: Array<SerializableAttributeValue> = [];
  for (const attribute of attributes) {
    const serialized = serializeAttribute(attribute);
    if (serialized !== null) {
      result.push(serialized);
    }
  }
  return result;
}

function serializeSpan(span: Span): SerializableSpan {
  const attributes = collectSerializedAttributes(span.attributes);

  const events: Array<SerializableSpanEvent> = [];
  for (const event of span.events) {
    events.push({
      name: event.name,
      timestamp: event.timestamp,
      attributes: collectSerializedAttributes(event.attributes),
    });
  }

  const resourceAttributes = collectSerializedAttributes(
    span.resource.attributes,
  );

  const status: SerializableSpanStatus =
    span.status.message !== undefined
      ? { code: span.status.code, message: span.status.message }
      : { code: span.status.code };

  if (span.parentSpanId !== undefined) {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: span.endTimeUnixNano,
      durationMs: span.durationMs,
      status,
      attributes,
      events,
      resource: {
        serviceName: span.resource.serviceName,
        attributes: resourceAttributes,
      },
    };
  }

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    durationMs: span.durationMs,
    status,
    attributes,
    events,
    resource: {
      serviceName: span.resource.serviceName,
      attributes: resourceAttributes,
    },
  };
}

function serializeTrace(trace: Trace): SerializableTrace {
  const spans: Array<SerializableSpan> = [];
  for (const span of trace.spans) {
    spans.push(serializeSpan(span));
  }
  return {
    traceId: trace.traceId,
    spans,
  };
}

export const getTrace = createServerFn({ method: 'GET' })
  .validator(S.standardSchemaV1(GetTraceInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const program = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.getTrace(data.traceId);
    }).pipe(
      Effect.map(
        (trace): GetTraceResult => ({
          notFound: false,
          trace: serializeTrace(trace),
        }),
      ),
      Effect.catchTag('TraceNotFound', (error) =>
        Effect.succeed({
          notFound: true as const,
          traceId: error.traceId,
        }),
      ),
    );
    const result = await RuntimeServer.runPromise(program);
    return result;
  });
