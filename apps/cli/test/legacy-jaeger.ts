interface SummaryLike {
  readonly traceId: string;
  readonly rootServiceName: string;
  readonly rootOperationName: string;
  readonly spanCount: number;
  readonly errorSpanCount: number;
  readonly services: ReadonlyArray<{ name: string; spanCount: number }>;
  readonly minStartTimeUnixNano: string;
  readonly maxEndTimeUnixNano: string;
}

/** A summary as Jaeger's legacy `/api/traces` would return it: `errorSpanCount` spans carry `error=true`. */
export const legacyTraceOf = (summary: SummaryLike) => {
  const startMicros = Number(BigInt(summary.minStartTimeUnixNano) / 1000n);
  const durationMicros = Number(
    (BigInt(summary.maxEndTimeUnixNano) -
      BigInt(summary.minStartTimeUnixNano)) /
      1000n,
  );
  const owners = summary.services.flatMap((service, serviceIndex) =>
    Array.from({ length: service.spanCount }, () => `p${serviceIndex}`),
  );
  return {
    traceID: summary.traceId,
    spans: owners.map((processID, index) => ({
      traceID: summary.traceId,
      spanID: `s${index}`,
      operationName: index === 0 ? summary.rootOperationName : 'child',
      references:
        index === 0
          ? []
          : [{ refType: 'CHILD_OF', traceID: summary.traceId, spanID: 's0' }],
      startTime: startMicros,
      duration: durationMicros,
      tags:
        index < summary.errorSpanCount
          ? [{ key: 'error', type: 'bool', value: true }]
          : [],
      processID,
    })),
    processes: Object.fromEntries(
      summary.services.map((service, index) => [
        `p${index}`,
        { serviceName: service.name },
      ]),
    ),
  };
};

/** The one legacy tag filter the fakes honor: `error=true` keeps traces with an error span. */
export const matchesLegacyTags = (
  summary: SummaryLike,
  tagsParam: string | null,
) => {
  if (tagsParam === null) return true;
  const tags = JSON.parse(tagsParam) as Record<string, string>;
  return tags.error !== 'true' || summary.errorSpanCount > 0;
};
