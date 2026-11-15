import { safe } from '@orpc/client';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { EmptyState, SkeletonRow, TraceDetailView } from '@traces/react';
import * as S from 'effect/Schema';
import { useEffect, useState } from 'react';
import { engine } from '#/lib/engine-client';

const TraceDetailSearchSchema = S.Struct({
  span: S.optional(S.String),
});

export const Route = createFileRoute('/_app/traces/$traceId')({
  validateSearch: S.toStandardSchemaV1(TraceDetailSearchSchema),
  component: TraceDetailPage,
  pendingComponent: TraceDetailPending,
  loader: async (ctx) => {
    const result = await safe(
      engine.traces.get({ traceId: ctx.params.traceId }),
    );
    if (result.isSuccess) {
      return {
        trace: result.data,
        notFound: false,
        error: null as Error | null,
      };
    }
    if (
      result.definedError !== null &&
      result.definedError.code === 'TRACE_NOT_FOUND'
    ) {
      return { trace: null, notFound: true, error: null as Error | null };
    }
    return {
      trace: null,
      notFound: false,
      error:
        result.error instanceof Error
          ? result.error
          : new Error(String(result.error)),
    };
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

  if (loaderData.notFound) {
    return (
      <div className="px-4 py-6">
        <EmptyState message="trace not found or expired" />
      </div>
    );
  }

  if (loaderData.error !== null || loaderData.trace === null) {
    return (
      <div className="px-4 py-12 text-body text-status-error">
        failed to load trace
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
      <TraceDetailView
        trace={loaderData.trace}
        selectedSpanId={selectedSpanId}
        onSelectSpan={handleSelectSpan}
        deepLinkSpanId={search.span ?? null}
      />
    </div>
  );
}
