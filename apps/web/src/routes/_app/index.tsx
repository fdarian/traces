import {
  Await,
  createFileRoute,
  defer,
  useRouter,
} from '@tanstack/react-router';
import * as S from 'effect/Schema';
import { useCallback } from 'react';
import { engine } from '#/lib/engine-client';
import {
  computeTimeRange,
  GlobalFilterSchema,
  normalizeGlobalFilters,
} from '#/lib/filters';
import { formatClock, SAMPLED_TITLE, traceCountLabel } from '#/lib/utils';
import { HomeRecentTraces } from './home/-home-recent-traces.js';
import { HomeServiceHealth } from './home/-home-service-health.js';
import { HomeTopIssues } from './home/-home-top-issues.js';
import { HomeTrendChart } from './home/-home-trend-chart.js';
import { SectionErrorBoundary } from './home/-section-error-boundary.js';

const HOUR_MS = 60 * 60 * 1000;

export const Route = createFileRoute('/_app/')({
  validateSearch: S.toStandardSchemaV1(GlobalFilterSchema),
  component: HomePage,
  pendingComponent: HomePending,
  loaderDeps: (opts) => ({ search: opts.search }),
  loader: async (ctx) => {
    const global = normalizeGlobalFilters(ctx.deps.search);
    const timeRange = computeTimeRange(global.range);
    const startTime = new Date(timeRange.startTimeMin).getTime();
    const endTime = new Date(timeRange.startTimeMax).getTime();

    const services =
      global.service.length > 0 ? [...global.service] : undefined;
    const since = new Date(Date.now() - 24 * HOUR_MS);
    const service = global.service[0];

    const [stats, trend, topIssues] = await Promise.all([
      engine.home.stats({
        services,
        startTime,
        endTime,
      }),
      engine.home.trend({
        services,
        startTime,
        endTime,
      }),
      engine.home.topIssues({
        services,
        limit: 8,
        since: since.getTime(),
      }),
    ]);

    const errorRatePromise =
      service !== undefined
        ? engine.home.errorRate({
            service,
            startTimeMin: timeRange.startTimeMin,
            startTimeMax: timeRange.startTimeMax,
          })
        : Promise.resolve(null);

    const serviceHealthPromise = engine.home
      .serviceHealth({
        startTimeMin: timeRange.startTimeMin,
        startTimeMax: timeRange.startTimeMax,
      })
      .then((result) => result.services);

    const recentTracesPromise =
      service !== undefined
        ? engine.home.recentErrorTraces({
            service,
            startTimeMin: timeRange.startTimeMin,
            startTimeMax: timeRange.startTimeMax,
          })
        : Promise.resolve([]);

    return {
      stats,
      trend,
      topIssues,
      timeRange,
      services: global.service,
      errorRate: defer(errorRatePromise),
      serviceHealth: defer(serviceHealthPromise),
      recentTraces: defer(recentTracesPromise),
    };
  },
});

function HomePending() {
  return (
    <div className="flex flex-col gap-6 px-4 py-6">
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex h-20 flex-col justify-center gap-1 rounded border border-border-subtle bg-bg-subtle px-3"
          >
            <div className="h-3 w-20 animate-shimmer rounded bg-bg-raised" />
            <div className="h-6 w-16 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
      <div className="h-48 rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-full items-center justify-center">
          <div className="h-32 w-full animate-shimmer rounded bg-bg-raised" />
        </div>
      </div>
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          top unresolved issues
        </div>
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
          >
            <div className="h-3 w-32 animate-shimmer rounded bg-bg-raised" />
            <div className="h-3 w-16 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          service health
        </div>
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
          >
            <div className="h-3 w-20 animate-shimmer rounded bg-bg-raised" />
            <div className="h-3 w-12 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          recent error traces
        </div>
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
          >
            <div className="h-3 w-32 animate-shimmer rounded bg-bg-raised" />
            <div className="h-3 w-16 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
    </div>
  );
}

function HomePage() {
  const router = useRouter();
  const loaderData = Route.useLoaderData();
  const search = Route.useSearch();
  const global = normalizeGlobalFilters(search);

  const handleServiceClick = useCallback(
    (service: string) => {
      const next = new Set(global.service);
      if (next.has(service)) {
        next.delete(service);
      } else {
        next.add(service);
      }
      router.navigate({
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          service: Array.from(next),
        }),
      } as Record<string, unknown>);
    },
    [global.service, router],
  );

  return (
    <div className="flex flex-col gap-6 px-4 py-6">
      <SectionErrorBoundary
        fallback={
          <div className="rounded border border-border-subtle bg-bg-subtle px-3 py-6">
            <p className="text-body text-status-error">failed to load stats</p>
          </div>
        }
      >
        <div className="grid grid-cols-4 gap-3">
          <StatCell
            label="error occurrences"
            value={loaderData.stats.occurrenceCount}
            delta={loaderData.stats.occurrenceDelta}
            format="count"
          />
          <StatCell
            label="active issues"
            value={loaderData.stats.activeIssueCount}
            delta={loaderData.stats.activeIssueDelta}
            format="count"
          />
          <StatCell
            label="services reporting"
            value={loaderData.stats.serviceCount}
            delta={loaderData.stats.serviceDelta}
            format="count"
          />
          <SectionErrorBoundary
            fallback={
              <div className="flex h-20 flex-col justify-center gap-1 rounded border border-border-subtle bg-bg-subtle px-3">
                <span className="text-label uppercase tracking-wide text-text-tertiary">
                  error rate
                </span>
                <span className="font-data text-data text-status-error">
                  failed to load
                </span>
              </div>
            }
          >
            <Await
              promise={loaderData.errorRate}
              fallback={
                <div className="flex h-20 flex-col justify-center gap-1 rounded border border-border-subtle bg-bg-subtle px-3">
                  <span className="text-label uppercase tracking-wide text-text-tertiary">
                    error rate
                  </span>
                  <div className="h-6 w-16 animate-shimmer rounded bg-bg-raised" />
                </div>
              }
            >
              {(errorRate) => (
                <StatCell
                  label="error rate"
                  value={errorRate !== null ? errorRate.errorRate : null}
                  delta={errorRate !== null ? errorRate.errorRateDelta : null}
                  format="percent"
                  coverage={errorRate}
                />
              )}
            </Await>
          </SectionErrorBoundary>
        </div>
      </SectionErrorBoundary>

      <HomeTrendChart buckets={loaderData.trend} isLoading={false} />

      <HomeTopIssues
        issues={loaderData.topIssues.issues}
        histograms={loaderData.topIssues.histograms}
        isLoading={false}
        getIssueHref={(issueId) => `/issues/${issueId}`}
        getIssuesHref={() => '/issues'}
      />

      <SectionErrorBoundary
        fallback={
          <div className="rounded border border-border-subtle bg-bg-subtle px-3 py-6">
            <p className="text-body text-status-error">
              failed to load service health
            </p>
          </div>
        }
      >
        <Await
          promise={loaderData.serviceHealth}
          fallback={
            <div className="rounded border border-border-subtle bg-bg-subtle">
              <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
                service health
              </div>
              {Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={index}
                  className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
                >
                  <div className="h-3 w-20 animate-shimmer rounded bg-bg-raised" />
                  <div className="h-3 w-12 animate-shimmer rounded bg-bg-raised" />
                </div>
              ))}
            </div>
          }
        >
          {(health) => (
            <HomeServiceHealth
              health={health}
              isLoading={false}
              onServiceClick={handleServiceClick}
            />
          )}
        </Await>
      </SectionErrorBoundary>

      <SectionErrorBoundary
        fallback={
          <div className="rounded border border-border-subtle bg-bg-subtle px-3 py-6">
            <p className="text-body text-status-error">
              failed to load recent traces
            </p>
          </div>
        }
      >
        <Await
          promise={loaderData.recentTraces}
          fallback={
            <div className="rounded border border-border-subtle bg-bg-subtle">
              <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
                recent error traces
              </div>
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
                >
                  <div className="h-3 w-32 animate-shimmer rounded bg-bg-raised" />
                  <div className="h-3 w-16 animate-shimmer rounded bg-bg-raised" />
                </div>
              ))}
            </div>
          }
        >
          {(traces) => (
            <HomeRecentTraces
              traces={traces}
              isLoading={false}
              getTraceHref={(traceId) => `/traces/${traceId}`}
            />
          )}
        </Await>
      </SectionErrorBoundary>
    </div>
  );
}

function StatCell(props: {
  readonly label: string;
  readonly value: number | null;
  readonly delta: number | null;
  readonly format: 'count' | 'percent';
  readonly coverage?: {
    readonly traceCount: number;
    readonly exact: boolean;
    readonly collectingSince: number | null;
  } | null;
}) {
  const value = props.value;
  const delta = props.delta;
  const coverage = props.coverage;

  const formattedValue = (() => {
    if (value === null) return '—';
    if (props.format === 'percent') {
      return `${value.toFixed(1)}%`;
    }
    return value.toString();
  })();

  const deltaClass = (() => {
    if (delta === null) return 'text-text-tertiary';
    if (delta > 0) return 'text-status-error';
    if (delta < 0) return 'text-status-ok';
    return 'text-text-tertiary';
  })();

  const formattedDelta = (() => {
    if (delta === null) return '';
    if (delta === 0) return '+0';
    const sign = delta > 0 ? '+' : '';
    if (props.format === 'percent') {
      return `${sign}${delta.toFixed(1)}%`;
    }
    return `${sign}${delta}`;
  })();

  return (
    <div className="flex h-20 flex-col justify-center gap-1 rounded border border-border-subtle bg-bg-subtle px-3">
      <span className="text-label uppercase tracking-wide text-text-tertiary">
        {props.label}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="font-data text-title text-text-primary tabular-nums">
          {formattedValue}
        </span>
        {delta !== null && (
          <span className={`font-data text-data ${deltaClass}`}>
            {formattedDelta}
          </span>
        )}
      </div>
      {coverage !== undefined && coverage !== null && (
        <span
          className="text-label text-text-tertiary"
          title={coverage.exact ? undefined : SAMPLED_TITLE}
        >
          {traceCountLabel(coverage.traceCount, coverage.exact)} traces
          {coverage.collectingSince !== null &&
            ` · collecting since ${formatClock(coverage.collectingSince)}`}
        </span>
      )}
    </div>
  );
}
