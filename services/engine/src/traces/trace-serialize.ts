import type { Span, Trace } from '@traces/contract';
import type {
  AttributeValue,
  Span as CoreSpan,
  Trace as CoreTrace,
  SerializableAttributeValue,
} from '@traces/core';
import { serializeAttribute } from '@traces/core';

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

function serializeSpan(span: CoreSpan): Span {
  const attributes = collectSerializedAttributes(span.attributes);

  const events: Array<Span['events'][number]> = [];
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

  const status: Span['status'] =
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

export function serializeTrace(trace: CoreTrace): Trace {
  const spans: Array<Span> = [];
  for (const span of trace.spans) {
    spans.push(serializeSpan(span));
  }
  return {
    traceId: trace.traceId,
    spans,
  };
}
