import type { Trace, TraceSummary } from '../model.js';
import { nanosToMs } from '../normalize.js';

export function computeTraceSummary(trace: Trace): TraceSummary {
  const rootSpan = trace.spans.find((s) => s.parentSpanId === undefined);
  const rootService =
    rootSpan !== undefined ? rootSpan.resource.serviceName : 'unknown';
  const rootOperation = rootSpan !== undefined ? rootSpan.name : 'unknown';

  const serviceMap: Map<string, number> = new Map();
  let errorSpanCount = 0;
  let minStart = BigInt('0');
  let maxEnd = BigInt('0');
  let first = true;

  for (const span of trace.spans) {
    const serviceName = span.resource.serviceName;
    serviceMap.set(serviceName, (serviceMap.get(serviceName) ?? 0) + 1);
    if (span.status.code === 'error') {
      errorSpanCount += 1;
    }
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    if (first) {
      minStart = start;
      maxEnd = end;
      first = false;
    } else {
      if (start < minStart) {
        minStart = start;
      }
      if (end > maxEnd) {
        maxEnd = end;
      }
    }
  }

  const services = Array.from(serviceMap.entries()).map(
    ([name, spanCount]) => ({ name, spanCount }),
  );

  const durationMs = nanosToMs(maxEnd - minStart);

  return {
    traceId: trace.traceId,
    rootService,
    rootOperation,
    spanCount: trace.spans.length,
    errorSpanCount,
    services,
    startTimeUnixNano: minStart.toString(),
    durationMs,
  };
}

const hasAttribute = (
  attributes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
  key: string,
  value: string,
): boolean =>
  attributes.some(
    (attribute) => attribute.key === key && String(attribute.value) === value,
  );

/** A trace matches when each attribute is set to exactly this string on some span or its resource. */
export const traceMatchesAttributes = (
  trace: Trace,
  attributes: Readonly<Record<string, string>>,
): boolean =>
  Object.entries(attributes).every(([key, value]) =>
    trace.spans.some(
      (span) =>
        hasAttribute(span.attributes, key, value) ||
        hasAttribute(span.resource.attributes, key, value),
    ),
  );
