import type { Span, Trace } from '@traces/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CopyText } from './copy-text.js';
import { Duration } from './duration.js';
import { ServiceBadge } from './service-badge.js';
import { SpanDetailPanel } from './span-detail-panel.js';
import { StatusBadge } from './status-badge.js';
import { TraceWaterfall } from './trace-waterfall.js';
import {
  buildSpanTree,
  collectAncestorSpanIds,
  collectDefaultCollapsed,
  expandCollapsedAncestors,
  flattenSpanTree,
  ORPHAN_ROOT_ID,
} from './utils/span-tree.js';
import { computeTraceTimeBounds } from './utils/time-scale.js';

const AUTO_COLLAPSE_THRESHOLD = 500;

interface TraceHeaderInfo {
  readonly hasRoot: boolean;
  readonly rootOperation: string | null;
  readonly rootService: string | null;
  readonly durationMs: number;
  readonly spanCount: number;
  readonly errorSpanCount: number;
  readonly services: ReadonlyArray<string>;
  readonly startTimeMs: number;
}

function computeHeaderInfo(trace: Trace): TraceHeaderInfo {
  const tree = buildSpanTree(trace.spans);
  const rootNode = tree.find(
    (node) => !node.isOrphanRoot && node.span !== null,
  );
  const bounds = computeTraceTimeBounds(trace.spans);
  const serviceSet = new Set<string>();
  let errorSpanCount = 0;

  for (const span of trace.spans) {
    serviceSet.add(span.resource.serviceName);
    if (span.status.code === 'error') {
      errorSpanCount += 1;
    }
  }

  const rootSpan = rootNode?.span ?? null;

  return {
    hasRoot: rootSpan !== null,
    rootOperation: rootSpan !== null ? rootSpan.name : null,
    rootService: rootSpan !== null ? rootSpan.resource.serviceName : null,
    durationMs: bounds.endMs - bounds.startMs,
    spanCount: trace.spans.length,
    errorSpanCount,
    services: Array.from(serviceSet),
    startTimeMs: bounds.startMs,
  };
}

function findSpan(spans: ReadonlyArray<Span>, spanId: string): Span | null {
  for (const span of spans) {
    if (span.spanId === spanId) {
      return span;
    }
  }
  return null;
}

export function TraceDetailView(props: {
  readonly trace: Trace;
  readonly selectedSpanId: string | null;
  readonly onSelectSpan: (spanId: string | null) => void;
  readonly deepLinkSpanId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tree = useMemo(
    () => buildSpanTree(props.trace.spans),
    [props.trace.spans],
  );
  const [collapsed, setCollapsed] = useState(() =>
    collectDefaultCollapsed(
      tree,
      props.trace.spans.length,
      AUTO_COLLAPSE_THRESHOLD,
    ),
  );
  const [animateBars, setAnimateBars] = useState(true);
  const header = useMemo(() => computeHeaderInfo(props.trace), [props.trace]);

  const visibleRows = useMemo(
    () => flattenSpanTree(tree, collapsed),
    [tree, collapsed],
  );

  const selectableRows = useMemo(
    () => visibleRows.filter((row) => row.span !== null && !row.isOrphanRoot),
    [visibleRows],
  );

  const selectedSpan = useMemo(() => {
    if (props.selectedSpanId === null) {
      return null;
    }
    return findSpan(props.trace.spans, props.selectedSpanId);
  }, [props.selectedSpanId, props.trace.spans]);

  const panelOpen = selectedSpan !== null;

  useEffect(() => {
    setAnimateBars(true);
    const rowCount = props.trace.spans.length;
    const timeout = window.setTimeout(
      () => setAnimateBars(false),
      rowCount * 8 + 200,
    );
    return () => window.clearTimeout(timeout);
  }, [props.trace.traceId, props.trace.spans.length]);

  useEffect(() => {
    const deepLink = props.deepLinkSpanId;
    if (deepLink === undefined || deepLink === null) {
      return;
    }
    const exists = findSpan(props.trace.spans, deepLink);
    if (exists === null) {
      return;
    }

    const ancestors = collectAncestorSpanIds(deepLink, props.trace.spans);
    if (ancestors.length > 0) {
      setCollapsed((current) => expandCollapsedAncestors(current, ancestors));
    }

    if (props.selectedSpanId !== deepLink) {
      props.onSelectSpan(deepLink);
    }
  }, [
    props.deepLinkSpanId,
    props.selectedSpanId,
    props.trace.spans,
    props.trace.traceId,
    props.onSelectSpan,
  ]);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        props.onSelectSpan(null);
        return;
      }

      const currentId = props.selectedSpanId;
      const currentIndex = selectableRows.findIndex(
        (row) => row.spanId === currentId,
      );

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (selectableRows.length === 0) {
          return;
        }
        const nextIndex =
          currentIndex === -1
            ? 0
            : Math.min(currentIndex + 1, selectableRows.length - 1);
        const nextRow = selectableRows[nextIndex];
        if (nextRow !== undefined) {
          props.onSelectSpan(nextRow.spanId);
        }
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (selectableRows.length === 0) {
          return;
        }
        const nextIndex =
          currentIndex === -1
            ? selectableRows.length - 1
            : Math.max(currentIndex - 1, 0);
        const nextRow = selectableRows[nextIndex];
        if (nextRow !== undefined) {
          props.onSelectSpan(nextRow.spanId);
        }
        return;
      }

      if (currentId === null) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = new Set(collapsed);
        next.add(currentId);
        setCollapsed(next);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const next = new Set(collapsed);
        next.delete(currentId);
        setCollapsed(next);
      }
    };

    element.addEventListener('keydown', handleKeyDown);
    return () => element.removeEventListener('keydown', handleKeyDown);
  }, [collapsed, props.onSelectSpan, props.selectedSpanId, selectableRows]);

  const startLabel = new Date(header.startTimeMs).toISOString();

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-default px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {header.hasRoot ? (
            <>
              <span className="truncate text-title font-semibold text-text-primary">
                {header.rootOperation}
              </span>
              {header.rootService !== null && (
                <ServiceBadge name={header.rootService} />
              )}
            </>
          ) : (
            <span className="text-title font-semibold text-text-secondary">
              no root span
            </span>
          )}
        </div>

        <Duration ms={header.durationMs} />

        <span className="font-data text-data text-text-secondary">
          {header.spanCount} spans
        </span>

        {header.errorSpanCount > 0 && (
          <StatusBadge status="error" label={String(header.errorSpanCount)} />
        )}

        <div className="flex flex-wrap items-center gap-1">
          {header.services.map((service) => (
            <ServiceBadge key={service} name={service} />
          ))}
        </div>

        <span
          className="font-data text-data text-text-tertiary"
          title={startLabel}
        >
          {startLabel}
        </span>

        <CopyText
          value={props.trace.traceId}
          className="font-data text-data text-text-tertiary hover:text-accent"
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <TraceWaterfall
          trace={props.trace}
          selectedSpanId={props.selectedSpanId}
          onSelectSpan={props.onSelectSpan}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          animateBars={animateBars}
          scrollToSpanId={props.selectedSpanId ?? props.deepLinkSpanId ?? null}
        />

        <SpanDetailPanel
          span={selectedSpan}
          open={panelOpen}
          onClose={() => props.onSelectSpan(null)}
        />
      </div>
    </div>
  );
}

export { ORPHAN_ROOT_ID };
