import {
  createFileRoute,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import {
  fillHistogramCounts,
  IssueDetail,
  type IssueDetailData,
  type IssueOccurrenceRow,
  SkeletonRow,
} from '@traces/react';
import * as S from 'effect/Schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { engine } from '#/lib/engine-client';
import { IssueFilterSchema } from '#/lib/filters';

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_SPARKLINE_SLOTS = 14;

export const Route = createFileRoute('/_app/issues/$issueId')({
  validateSearch: S.toStandardSchemaV1(IssueFilterSchema),
  component: IssueDetailPage,
  pendingComponent: IssueDetailPending,
  errorComponent: IssueDetailError,
  loader: async (ctx) => {
    const issueId = Number(ctx.params.issueId);
    const page = 1;
    const result = await engine.issues.get({
      issueId,
      page,
    });
    return { result, issueId };
  },
});

function IssueDetailError(props: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12">
      <p className="text-body text-status-error">failed to load issue</p>
      <p className="font-data text-data text-text-tertiary">
        {props.error instanceof Error
          ? props.error.message
          : String(props.error)}
      </p>
    </div>
  );
}

function IssueDetailPending() {
  return (
    <div className="px-4 py-6">
      <SkeletonRow height={48} className="mb-4 rounded" />
      <SkeletonRow height={120} className="mb-4 rounded" />
      {Array.from({ length: 6 }).map((_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

function IssueDetailPage() {
  const loaderData = Route.useLoaderData();
  const [data, setData] = useState(loaderData.result);
  const [page, setPage] = useState(loaderData.result.page);
  const [isLoadingOccurrences, setIsLoadingOccurrences] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setData(loaderData.result);
    setPage(loaderData.result.page);
    setError(null);
  }, [loaderData.result]);

  const issueData = useMemo((): IssueDetailData => {
    const windowEnd = Date.now();
    const latest = data.latestOccurrence;
    return {
      id: data.issue.id,
      exceptionType: data.issue.exceptionType,
      title: data.issue.title,
      service: data.issue.service,
      status: data.issue.status,
      firstSeen: data.issue.firstSeen,
      lastSeen: data.issue.lastSeen,
      occurrenceCount: data.issue.occurrenceCount,
      resolvedAt: data.issue.resolvedAt,
      regressed: data.issue.regressed,
      sparklineCounts: fillHistogramCounts({
        buckets: data.histogram,
        slotCount: DETAIL_SPARKLINE_SLOTS,
        slotMs: DAY_MS,
        windowEnd,
      }),
      latestMessage: latest?.exceptionMessage ?? '',
      latestStacktrace: latest?.exceptionStacktrace ?? '',
    };
  }, [data]);

  const occurrenceRows = useMemo((): ReadonlyArray<IssueOccurrenceRow> => {
    const result: Array<IssueOccurrenceRow> = [];
    for (const occurrence of data.occurrences) {
      result.push({
        id: occurrence.id,
        timestamp: occurrence.timestamp,
        exceptionMessage: occurrence.exceptionMessage,
        traceId: occurrence.traceId,
        spanId: occurrence.spanId,
        serviceName: occurrence.serviceName,
      });
    }
    return result;
  }, [data.occurrences]);

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));

  const loadPage = useCallback(
    async (nextPage: number) => {
      if (nextPage < 1 || nextPage > totalPages) {
        return;
      }
      setIsLoadingOccurrences(true);
      setError(null);
      try {
        const result = await engine.issues.get({
          issueId: loaderData.issueId,
          page: nextPage,
        });
        setData((prev: typeof loaderData.result) => ({
          ...prev,
          occurrences: result.occurrences,
          page: result.page,
          totalCount: result.totalCount,
        }));
        setPage(result.page);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoadingOccurrences(false);
      }
    },
    [loaderData.issueId, totalPages],
  );

  const handleResolve = useCallback(async () => {
    const previous = data;
    setIsResolving(true);
    setError(null);
    setData({
      ...data,
      issue: {
        ...data.issue,
        status: 'resolved',
        resolvedAt: Date.now(),
        regressed: false,
      },
    });
    try {
      await engine.issues.resolve({ issueId: loaderData.issueId });
    } catch (err) {
      setData(previous);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsResolving(false);
    }
  }, [data, loaderData.issueId]);

  const handleUnresolve = useCallback(async () => {
    const previous = data;
    setIsResolving(true);
    setError(null);
    setData({
      ...data,
      issue: {
        ...data.issue,
        status: 'unresolved',
        resolvedAt: null,
        regressed: false,
      },
    });
    try {
      await engine.issues.unresolve({ issueId: loaderData.issueId });
    } catch (err) {
      setData(previous);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsResolving(false);
    }
  }, [data, loaderData.issueId]);

  if (error !== null) {
    return (
      <div className="px-4 py-12 text-body text-status-error">
        {error.message}
      </div>
    );
  }

  return (
    <div className="px-4 py-6">
      <IssueDetail
        issue={issueData}
        occurrences={occurrenceRows}
        page={page}
        totalPages={totalPages}
        isLoadingOccurrences={isLoadingOccurrences}
        onPageChange={loadPage}
        onResolve={handleResolve}
        onUnresolve={handleUnresolve}
        isResolving={isResolving}
        getTraceHref={(traceId, spanId) => `/traces/${traceId}?span=${spanId}`}
      />
    </div>
  );
}
