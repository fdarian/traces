import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { Trace } from '@traces/core';
import { EmptyState, SkeletonRow, TraceDetailView } from '@traces/react';
import * as S from 'effect/Schema';
import { useEffect, useState } from 'react';
import { getTrace } from '#/server/get-trace.functions';

const TraceDetailSearchSchema = S.Struct({
  span: S.optional(S.String),
});

export const Route = createFileRoute('/_app/traces/$traceId')({
  validateSearch: S.standardSchemaV1(TraceDetailSearchSchema),
  component: TraceDetailPage,
  pendingComponent: TraceDetailPending,
  loader: async (ctx) => {
    const traceId = ctx.params.traceId;
    try {
      const result = await getTrace({ data: { traceId } });
      return { result, error: null as Error | null };
    } catch (err) {
      return {
        result: null,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  },
});

function TraceDetailPending() {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
      <SkeletonRow height={48} className="mb-3 rounded" />
      <SkeletonRow height={40} className="mb-2 rounded" />
      {Array.from({ length: 8 }).map((_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

function TraceDetailPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(
    search.span ?? null,
  );

  useEffect(() => {
    setSelectedSpanId(search.span ?? null);
  }, [search.span]);

  const handleSelectSpan = (spanId: string | null) => {
    setSelectedSpanId(spanId);
    router.navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        span: spanId ?? undefined,
      }),
    } as Record<string, unknown>);
  };

  if (loaderData.error !== null) {
    return (
      <div className="px-4 py-12 text-body text-status-error">
        failed to load trace
      </div>
    );
  }

  if (loaderData.result === null) {
    return (
      <div className="px-4 py-12 text-body text-status-error">
        failed to load trace
      </div>
    );
  }

  const result = loaderData.result;

  if (result.notFound) {
    return (
      <div className="px-4 py-6">
        <EmptyState message="trace not found or expired" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
      <TraceDetailView
        trace={result.trace as Trace}
        selectedSpanId={selectedSpanId}
        onSelectSpan={handleSelectSpan}
        deepLinkSpanId={search.span ?? null}
      />
    </div>
  );
}
