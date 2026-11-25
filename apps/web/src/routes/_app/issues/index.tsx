import {
  createFileRoute,
  type ErrorComponentProps,
  useRouter,
} from '@tanstack/react-router';
import {
  fillHistogramCounts,
  type IssueListRow,
  IssueListTable,
  SkeletonRow,
} from '@traces/react';
import * as S from 'effect/Schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { engine } from '#/lib/engine-client';
import {
  GlobalFilterSchema,
  IssueFilterSchema,
  normalizeGlobalFilters,
  normalizeIssueFilters,
} from '#/lib/filters';

const HOUR_MS = 60 * 60 * 1000;
const LIST_SPARKLINE_SLOTS = 24;

export const Route = createFileRoute('/_app/issues/')({
  validateSearch: S.toStandardSchemaV1(
    GlobalFilterSchema.pipe(S.fieldsAssign(IssueFilterSchema.fields)),
  ),
  component: IssuesPage,
  pendingComponent: IssuesPending,
  errorComponent: IssuesError,
  loaderDeps: (opts) => ({ search: opts.search }),
  loader: async (ctx) => {
    const global = normalizeGlobalFilters(ctx.deps.search);
    const local = normalizeIssueFilters(ctx.deps.search);
    const result = await engine.issues.list({
      status: local.status,
      services: global.service.length > 0 ? [...global.service] : undefined,
    });
    return { result };
  },
});

function IssuesError(props: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12">
      <p className="text-body text-status-error">failed to load issues</p>
      <p className="font-data text-data text-text-tertiary">
        {props.error instanceof Error
          ? props.error.message
          : String(props.error)}
      </p>
    </div>
  );
}

function IssuesPending() {
  return (
    <div className="px-4 py-6">
      <div className="mb-4 flex h-10 items-center gap-3 border-b border-border-default px-3">
        <SkeletonRow height={40} className="w-24" />
        <SkeletonRow height={40} className="w-24" />
      </div>
      {Array.from({ length: 5 }).map((_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

function IssuesPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const global = normalizeGlobalFilters(search);
  const local = normalizeIssueFilters(search);

  const [issues, setIssues] = useState(loaderData.result.issues);
  const [summary, setSummary] = useState(loaderData.result.summary);
  const [resolvingIssueId, setResolvingIssueId] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setIssues(loaderData.result.issues);
    setSummary(loaderData.result.summary);
    setError(null);
  }, [loaderData.result]);

  const rows = useMemo((): ReadonlyArray<IssueListRow> => {
    const windowEnd = Date.now();
    const result: Array<IssueListRow> = [];
    for (const issue of issues) {
      result.push({
        id: issue.id,
        exceptionType: issue.exceptionType,
        title: issue.title,
        service: issue.service,
        occurrenceCount: issue.occurrenceCount,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        status: issue.status,
        resolvedAt: issue.resolvedAt,
        regressed: issue.regressed,
        sparklineCounts: fillHistogramCounts({
          buckets: issue.histogram,
          slotCount: LIST_SPARKLINE_SLOTS,
          slotMs: HOUR_MS,
          windowEnd,
        }),
      });
    }
    return result;
  }, [issues]);

  const updateSearch = (patch: Partial<typeof IssueFilterSchema.Type>) => {
    router.navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
    } as Record<string, unknown>);
  };

  const handleResolve = useCallback(
    async (issueId: number) => {
      const previousIssues = issues;
      const previousSummary = summary;
      setResolvingIssueId(issueId);
      setError(null);

      if (local.status === 'unresolved') {
        const nextIssues = issues.filter((issue) => issue.id !== issueId);
        setIssues(nextIssues);
        setSummary({
          totalCount: Math.max(0, summary.totalCount - 1),
          serviceCount: countDistinctServices(nextIssues),
        });
      } else {
        setIssues(
          issues.map((issue) =>
            issue.id === issueId
              ? {
                  ...issue,
                  status: 'resolved' as const,
                  resolvedAt: Date.now(),
                  regressed: false,
                }
              : issue,
          ),
        );
      }

      try {
        await engine.issues.resolve({ issueId });
      } catch (err) {
        setIssues(previousIssues);
        setSummary(previousSummary);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setResolvingIssueId(null);
      }
    },
    [issues, summary, local.status],
  );

  const summaryLine = `${summary.totalCount} ${local.status} · ${summary.serviceCount} service${summary.serviceCount === 1 ? '' : 's'}`;

  return (
    <div className="px-4 py-6">
      <div className="flex h-10 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <button
          type="button"
          onClick={() => updateSearch({ status: 'unresolved' })}
          className={`transition-colors duration-120 hover:text-text-primary ${local.status === 'unresolved' ? 'text-accent' : ''}`}
        >
          unresolved
        </button>
        <button
          type="button"
          onClick={() => updateSearch({ status: 'resolved' })}
          className={`transition-colors duration-120 hover:text-text-primary ${local.status === 'resolved' ? 'text-accent' : ''}`}
        >
          resolved
        </button>
        {global.service.length > 0 && (
          <span className="text-text-tertiary">
            · {global.service.join(', ')}
          </span>
        )}
      </div>

      <div className="py-2 text-label uppercase tracking-wide text-text-tertiary">
        {summaryLine}
      </div>

      <IssueListTable
        issues={rows}
        isLoading={false}
        error={error}
        getIssueHref={(issueId) => `/issues/${issueId}`}
        onResolve={handleResolve}
        resolvingIssueId={resolvingIssueId}
      />
    </div>
  );
}

function countDistinctServices(
  issues: ReadonlyArray<{ readonly service: string }>,
): number {
  const services = new Set<string>();
  for (const issue of issues) {
    services.add(issue.service);
  }
  return services.size;
}
