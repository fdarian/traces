import {
  createFileRoute,
  type ErrorComponentProps,
  useRouter,
} from '@tanstack/react-router';
import type { TraceSummary } from '@traces/core';
import { SkeletonRow, TraceListTable } from '@traces/react';
import * as S from 'effect/Schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  computeTimeRange,
  normalizeGlobalFilters,
  normalizeTraceFilters,
  parseAttributes,
  type RangeValue,
  TraceFilterSchema,
} from '#/lib/filters';
import { listOperations } from '#/server/list-operations.functions';
import { searchTraces } from '#/server/search-traces.functions';

export const Route = createFileRoute('/_app/traces')({
  validateSearch: S.standardSchemaV1(TraceFilterSchema),
  component: TracesPage,
  pendingComponent: TracesPending,
  errorComponent: TracesError,
  loader: async (ctx) => {
    const search = ctx.location.search as Record<string, unknown>;
    const global = normalizeGlobalFilters(search);
    const local = normalizeTraceFilters(search);
    const service = global.service[0];
    const timeRange = computeTimeRange(global.range);
    const limit = pageLimit(local.status);
    if (service === undefined) {
      return {
        traces: [] as ReadonlyArray<TraceSummary>,
        operations: [] as ReadonlyArray<string>,
        startTimeMin: timeRange.startTimeMin,
        startTimeMax: timeRange.startTimeMax,
        query: null as TraceQueryInput | null,
      };
    }
    const query = buildTraceQuery(service, timeRange, local, limit);
    const [traces, operations] = await Promise.all([
      searchTraces({ data: query }),
      listOperations({ data: service }),
    ]);
    return {
      traces,
      operations,
      startTimeMin: timeRange.startTimeMin,
      startTimeMax: timeRange.startTimeMax,
      query,
    };
  },
});

type TraceQueryInput = {
  service: string;
  startTimeMin: string;
  startTimeMax: string;
  operation?: string;
  minDuration?: string;
  maxDuration?: string;
  attributes?: Record<string, string>;
  limit: number;
};

function pageLimit(status: 'all' | 'errors-only'): number {
  return status === 'errors-only' ? 200 : 50;
}

function buildTraceQuery(
  service: string,
  timeRange: { startTimeMin: string; startTimeMax: string },
  local: ReturnType<typeof normalizeTraceFilters>,
  limit: number,
): TraceQueryInput {
  return {
    service,
    startTimeMin: timeRange.startTimeMin,
    startTimeMax: timeRange.startTimeMax,
    operation: local.operation,
    minDuration: local.minDuration,
    maxDuration: local.maxDuration,
    attributes: parseAttributes(local.attributes),
    limit,
  };
}

function TracesError(props: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12">
      <p className="text-body text-status-error">failed to load traces</p>
      <p className="font-data text-data text-text-tertiary">
        {props.error.message}
      </p>
    </div>
  );
}

function TracesPending() {
  return (
    <div className="px-4 py-6">
      <div className="mb-4 flex h-10 items-center gap-3 border-b border-border-default px-3">
        <div className="w-32">
          <SkeletonRow height={40} />
        </div>
        <div className="w-24">
          <SkeletonRow height={40} />
        </div>
        <div className="w-32">
          <SkeletonRow height={40} />
        </div>
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

function TracesPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const loaderData = Route.useLoaderData();

  const global = normalizeGlobalFilters(search);
  const local = normalizeTraceFilters(search);
  const limit = pageLimit(local.status);

  const [allTraces, setAllTraces] = useState(loaderData.traces);
  const [sort, setSort] = useState<'start' | 'duration'>('start');
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(loaderData.traces.length >= limit);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setAllTraces(loaderData.traces);
    setHasMore(loaderData.traces.length >= pageLimit(local.status));
    setError(null);
  }, [loaderData.traces, local.status]);

  const filteredTraces = useMemo(() => {
    let result = allTraces;
    if (local.status === 'errors-only') {
      result = result.filter((t) => t.errorSpanCount > 0);
    }
    if (local.operation !== undefined) {
      result = result.filter((t) => t.rootOperation === local.operation);
    }
    return result;
  }, [allTraces, local.status, local.operation]);

  const handleLoadMore = useCallback(async () => {
    if (loaderData.query === null) return;
    if (allTraces.length === 0) return;
    if (isLoading) return;
    setIsLoading(true);
    try {
      const oldest = allTraces.reduce((min, t) => {
        const tStart = BigInt(t.startTimeUnixNano);
        const minStart = BigInt(min.startTimeUnixNano);
        return tStart < minStart ? t : min;
      });
      const oldestMs = Number(
        BigInt(oldest.startTimeUnixNano) / BigInt(1000000),
      );
      const newStartTimeMax = new Date(oldestMs).toISOString();
      const newQuery = {
        ...loaderData.query,
        startTimeMax: newStartTimeMax,
      };
      const result = await searchTraces({ data: newQuery });
      if (result.length < loaderData.query.limit) {
        setHasMore(false);
      }
      const existingIds = new Set(allTraces.map((t) => t.traceId));
      const newTraces = result.filter((t) => !existingIds.has(t.traceId));
      if (newTraces.length > 0) {
        setAllTraces((prev) => [...prev, ...newTraces]);
      } else if (result.length === 0) {
        setHasMore(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [loaderData.query, allTraces, isLoading]);

  useEffect(() => {
    if (
      filteredTraces.length === 0 &&
      allTraces.length > 0 &&
      hasMore &&
      isLoading === false &&
      loaderData.query !== null
    ) {
      void handleLoadMore();
    }
  }, [
    filteredTraces.length,
    allTraces.length,
    hasMore,
    isLoading,
    loaderData.query,
    handleLoadMore,
  ]);

  const updateSearch = (patch: Partial<typeof TraceFilterSchema.Type>) => {
    router.navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
    } as Record<string, unknown>);
  };

  const service = global.service[0];
  const summary = `${filteredTraces.length} traces · ${formatRange(global.range)}`;

  return (
    <div className="px-4 py-6">
      <div className="flex h-10 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        {service !== undefined && (
          <select
            value={local.operation ?? ''}
            onChange={(e) =>
              updateSearch({
                operation: e.target.value === '' ? undefined : e.target.value,
              })
            }
            className="bg-transparent border border-border-default rounded px-1.5 py-0.5 text-body text-text-primary"
          >
            <option value="">all operations</option>
            {loaderData.operations.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => updateSearch({ status: 'all' })}
          className={`transition-colors duration-120 hover:text-text-primary ${local.status === 'all' ? 'text-accent' : ''}`}
        >
          all
        </button>
        <button
          type="button"
          onClick={() => updateSearch({ status: 'errors-only' })}
          className={`transition-colors duration-120 hover:text-text-primary ${local.status === 'errors-only' ? 'text-accent' : ''}`}
        >
          errors only
        </button>

        <input
          type="text"
          placeholder="min duration"
          defaultValue={local.minDuration ?? ''}
          onBlur={(e) =>
            updateSearch({
              minDuration: e.target.value === '' ? undefined : e.target.value,
            })
          }
          className="bg-transparent border border-border-default rounded px-1.5 py-0.5 text-body text-text-primary placeholder:text-text-tertiary"
        />
        <input
          type="text"
          placeholder="max duration"
          defaultValue={local.maxDuration ?? ''}
          onBlur={(e) =>
            updateSearch({
              maxDuration: e.target.value === '' ? undefined : e.target.value,
            })
          }
          className="bg-transparent border border-border-default rounded px-1.5 py-0.5 text-body text-text-primary placeholder:text-text-tertiary"
        />
        <input
          type="text"
          placeholder="key=value"
          defaultValue={local.attributes ?? ''}
          onBlur={(e) =>
            updateSearch({
              attributes: e.target.value === '' ? undefined : e.target.value,
            })
          }
          className="bg-transparent border border-border-default rounded px-1.5 py-0.5 text-body text-text-primary placeholder:text-text-tertiary"
        />
      </div>

      <div className="py-2 text-label uppercase tracking-wide text-text-tertiary">
        {summary}
      </div>

      <TraceListTable
        traces={filteredTraces}
        sort={sort}
        onSortChange={setSort}
        isLoading={isLoading}
        hasMore={hasMore}
        onLoadMore={handleLoadMore}
        error={error}
        getTraceHref={(traceId) => `/traces/${traceId}`}
      />
    </div>
  );
}

function formatRange(range: RangeValue | null): string {
  if (range === null) return 'last 1h';
  if (typeof range === 'object') return 'custom range';
  return `last ${range}`;
}
