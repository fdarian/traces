import { createFileRoute, useRouter } from '@tanstack/react-router';
import * as S from 'effect/Schema';
import { useCallback, useEffect, useState } from 'react';
import {
  computeTimeRange,
  GlobalFilterSchema,
  normalizeGlobalFilters,
} from '#/lib/filters';
import { homeErrorRate } from '#/server/home-error-rate.functions';
import { homeRecentErrorTraces } from '#/server/home-recent-error-traces.functions';
import { homeServiceHealth } from '#/server/home-service-health.functions';
import { homeStats } from '#/server/home-stats.functions';
import { homeTopIssues } from '#/server/home-top-issues.functions';
import { homeTrend } from '#/server/home-trend.functions';
import { HomeRecentTraces } from './home/home-recent-traces.js';
import { HomeServiceHealth } from './home/home-service-health.js';
import { HomeStatRow } from './home/home-stat-row.js';
import { HomeTopIssues } from './home/home-top-issues.js';
import { HomeTrendChart } from './home/home-trend-chart.js';

const HOUR_MS = 60 * 60 * 1000;

export const Route = createFileRoute('/_app/')({
  validateSearch: S.standardSchemaV1(GlobalFilterSchema),
  component: HomePage,
  pendingComponent: HomePending,
  loader: async (ctx: { location: { search: Record<string, unknown> } }) => {
    const search = ctx.location.search;
    const global = normalizeGlobalFilters(search);
    const timeRange = computeTimeRange(global.range);
    const startTime = new Date(timeRange.startTimeMin).getTime();
    const endTime = new Date(timeRange.startTimeMax).getTime();

    const services =
      global.service.length > 0 ? [...global.service] : undefined;
    const since = new Date(Date.now() - 24 * HOUR_MS);

    const [stats, trend, topIssues] = await Promise.all([
      homeStats({
        data: {
          services,
          startTime,
          endTime,
        },
      }),
      homeTrend({
        data: {
          services,
          startTime,
          endTime,
        },
      }),
      homeTopIssues({
        data: {
          services,
          limit: 8,
          since: since.getTime(),
        },
      }),
    ]);

    return {
      stats,
      trend,
      topIssues,
      timeRange,
      services: global.service,
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
    </div>
  );
}

function HomePage() {
  const router = useRouter();
  const loaderData = Route.useLoaderData();
  const search = Route.useSearch();
  const global = normalizeGlobalFilters(search);

  const [errorRate, setErrorRate] = useState<{
    errorRate: number;
    errorRateDelta: number;
    sampledTraceCount: number;
  } | null>(null);
  const [errorRateLoading, setErrorRateLoading] = useState(true);

  const [serviceHealth, setServiceHealth] = useState<
    ReadonlyArray<{
      service: string;
      traceCount: number;
      errorRate: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
    }>
  >([]);
  const [serviceHealthLoading, setServiceHealthLoading] = useState(true);

  const [recentTraces, setRecentTraces] = useState<
    ReadonlyArray<{
      traceId: string;
      rootService: string;
      rootOperation: string;
      spanCount: number;
      errorSpanCount: number | undefined;
      durationMs: number;
      startTimeUnixNano: string;
    }>
  >([]);
  const [recentTracesLoading, setRecentTracesLoading] = useState(true);

  useEffect(() => {
    setErrorRateLoading(true);
    setServiceHealthLoading(true);
    setRecentTracesLoading(true);

    const timeRange = loaderData.timeRange;
    const service = loaderData.services[0];

    let cancelled = false;

    async function loadErrorRate() {
      if (service === undefined) {
        setErrorRate(null);
        setErrorRateLoading(false);
        return;
      }
      try {
        const result = await homeErrorRate({
          data: {
            service,
            startTimeMin: timeRange.startTimeMin,
            startTimeMax: timeRange.startTimeMax,
          },
        });
        if (!cancelled) {
          setErrorRate(result);
        }
      } catch {
        if (!cancelled) {
          setErrorRate(null);
        }
      } finally {
        if (!cancelled) {
          setErrorRateLoading(false);
        }
      }
    }

    async function loadServiceHealth() {
      try {
        const result = await homeServiceHealth({
          data: {
            startTimeMin: timeRange.startTimeMin,
            startTimeMax: timeRange.startTimeMax,
          },
        });
        if (!cancelled) {
          setServiceHealth(result);
        }
      } catch {
        if (!cancelled) {
          setServiceHealth([]);
        }
      } finally {
        if (!cancelled) {
          setServiceHealthLoading(false);
        }
      }
    }

    async function loadRecentTraces() {
      if (service === undefined) {
        setRecentTraces([]);
        setRecentTracesLoading(false);
        return;
      }
      try {
        const result = await homeRecentErrorTraces({
          data: {
            service,
            startTimeMin: timeRange.startTimeMin,
            startTimeMax: timeRange.startTimeMax,
          },
        });
        if (!cancelled) {
          setRecentTraces(result);
        }
      } catch {
        if (!cancelled) {
          setRecentTraces([]);
        }
      } finally {
        if (!cancelled) {
          setRecentTracesLoading(false);
        }
      }
    }

    void loadErrorRate();
    void loadServiceHealth();
    void loadRecentTraces();

    return () => {
      cancelled = true;
    };
  }, [loaderData.timeRange, loaderData.services]);

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
      <HomeStatRow
        stats={loaderData.stats}
        errorRate={errorRateLoading ? null : errorRate}
        isLoading={false}
      />

      <HomeTrendChart buckets={loaderData.trend} isLoading={false} />

      <HomeTopIssues
        issues={loaderData.topIssues.issues}
        histograms={loaderData.topIssues.histograms}
        isLoading={false}
        getIssueHref={(issueId) => `/issues/${issueId}`}
        getIssuesHref={() => '/issues'}
      />

      <HomeServiceHealth
        health={serviceHealth}
        isLoading={serviceHealthLoading}
        onServiceClick={handleServiceClick}
      />

      <HomeRecentTraces
        traces={recentTraces}
        isLoading={recentTracesLoading}
        getTraceHref={(traceId) => `/traces/${traceId}`}
      />
    </div>
  );
}
