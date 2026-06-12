import './waterfall.css';
import type { Span, Trace } from '@traces/core';
import { normalizeTimestampToMs } from '@traces/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Duration } from './duration.js';
import { ServiceBadge, serviceColorValue } from './service-badge.js';
import { StatusBadge } from './status-badge.js';
import {
  buildSpanTree,
  collectDefaultCollapsed,
  type FlatSpanRow,
  flattenSpanTree,
  ORPHAN_ROOT_ID,
  spanStartMs,
} from './utils/span-tree.js';
import {
  computeTraceTimeBounds,
  generateTimeTicks,
  timeToX,
  type ZoomWindow,
} from './utils/time-scale.js';
import { MINIMAP_HEIGHT, WaterfallMinimap } from './waterfall-minimap.js';

const ROW_HEIGHT = 32;
const TREE_MIN_WIDTH = 280;
const AXIS_MIN_WIDTH = 320;
const INDENT_PX = 16;
const VIRTUALIZE_THRESHOLD = 200;
const AUTO_COLLAPSE_THRESHOLD = 500;
const SCROLL_OVERSCAN = 8;

function spanEndMs(span: Span): number {
  return normalizeTimestampToMs(span.endTimeUnixNano);
}

function isErrorSpan(span: Span): boolean {
  return span.status.code === 'error';
}

function computeVisibleRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  virtualize: boolean,
): {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
} {
  const totalHeight = rowCount * ROW_HEIGHT;
  if (!virtualize || rowCount <= VIRTUALIZE_THRESHOLD) {
    return {
      startIndex: 0,
      endIndex: rowCount,
      offsetTop: 0,
      totalHeight,
    };
  }

  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - SCROLL_OVERSCAN,
  );
  const visibleCount =
    Math.ceil(viewportHeight / ROW_HEIGHT) + SCROLL_OVERSCAN * 2;
  const endIndex = Math.min(rowCount, startIndex + visibleCount);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * ROW_HEIGHT,
    totalHeight,
  };
}

export function TraceWaterfall(props: {
  readonly trace: Trace;
  readonly selectedSpanId?: string | null;
  readonly onSelectSpan?: (spanId: string | null) => void;
  readonly collapsed?: ReadonlySet<string>;
  readonly onCollapsedChange?: (collapsed: ReadonlySet<string>) => void;
  readonly zoom?: ZoomWindow;
  readonly onZoomChange?: (zoom: ZoomWindow) => void;
  readonly animateBars?: boolean;
  readonly scrollToSpanId?: string | null;
}) {
  const axisRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const axisScrollRef = useRef<HTMLDivElement>(null);
  const [axisWidth, setAxisWidth] = useState(AXIS_MIN_WIDTH);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    const tree = buildSpanTree(props.trace.spans);
    return collectDefaultCollapsed(
      tree,
      props.trace.spans.length,
      AUTO_COLLAPSE_THRESHOLD,
    );
  });
  const bounds = useMemo(
    () => computeTraceTimeBounds(props.trace.spans),
    [props.trace.spans],
  );
  const [internalZoom, setInternalZoom] = useState<ZoomWindow>(() => ({
    startMs: bounds.startMs,
    endMs: bounds.endMs,
  }));

  const collapsed = props.collapsed ?? internalCollapsed;
  const setCollapsed = props.onCollapsedChange ?? setInternalCollapsed;
  const zoom = props.zoom ?? internalZoom;
  const setZoom = props.onZoomChange ?? setInternalZoom;
  const selectedSpanId = props.selectedSpanId ?? null;
  const onSelectSpan = props.onSelectSpan;

  const tree = useMemo(
    () => buildSpanTree(props.trace.spans),
    [props.trace.spans],
  );
  const rows = useMemo(
    () => flattenSpanTree(tree, collapsed),
    [tree, collapsed],
  );

  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const visibleRange = computeVisibleRange(
    rows.length,
    scrollTop,
    viewportHeight,
    virtualize,
  );
  const visibleRows = rows.slice(
    visibleRange.startIndex,
    visibleRange.endIndex,
  );

  useEffect(() => {
    const element = axisRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setAxisWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    setAxisWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = axisScrollRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const targetSpanId = props.scrollToSpanId;
    if (targetSpanId === undefined || targetSpanId === null) {
      return;
    }
    const index = rows.findIndex((row) => row.spanId === targetSpanId);
    if (index === -1) {
      return;
    }
    const top = index * ROW_HEIGHT;
    const treeElement = treeScrollRef.current;
    const axisElement = axisScrollRef.current;
    if (treeElement !== null) {
      treeElement.scrollTop = top;
    }
    if (axisElement !== null) {
      axisElement.scrollTop = top;
    }
    setScrollTop(top);
  }, [props.scrollToSpanId, rows]);

  const ticks = useMemo(() => generateTimeTicks(zoom, 8), [zoom]);

  const toggleCollapsed = (spanId: string) => {
    const next = new Set(collapsed);
    if (next.has(spanId)) {
      next.delete(spanId);
    } else {
      next.add(spanId);
    }
    setCollapsed(next);
  };

  const syncScroll = (source: 'tree' | 'axis', nextTop: number) => {
    setScrollTop(nextTop);
    const treeElement = treeScrollRef.current;
    const axisElement = axisScrollRef.current;
    if (source === 'tree' && axisElement !== null) {
      axisElement.scrollTop = nextTop;
    }
    if (source === 'axis' && treeElement !== null) {
      treeElement.scrollTop = nextTop;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col border border-border-subtle bg-bg-subtle">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="flex shrink-0 flex-col border-r border-border-subtle"
          style={{ minWidth: TREE_MIN_WIDTH, width: '38%' }}
        >
          <div
            className="shrink-0 border-b border-border-default bg-bg-subtle"
            style={{ height: MINIMAP_HEIGHT }}
          />
          <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center border-b border-border-default bg-bg-subtle px-3 text-label uppercase tracking-wide text-text-tertiary">
            span
          </div>
          <div
            ref={treeScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              syncScroll('tree', event.currentTarget.scrollTop);
            }}
          >
            <div
              style={{ height: visibleRange.totalHeight, position: 'relative' }}
            >
              <div
                style={{ transform: `translateY(${visibleRange.offsetTop}px)` }}
              >
                {visibleRows.map((row) => (
                  <WaterfallTreeRow
                    key={row.spanId}
                    row={row}
                    selected={selectedSpanId === row.spanId}
                    collapsed={collapsed.has(row.spanId)}
                    onToggle={() => toggleCollapsed(row.spanId)}
                    onSelect={() => {
                      if (onSelectSpan !== undefined && row.span !== null) {
                        onSelectSpan(row.spanId);
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <WaterfallMinimap
            spans={props.trace.spans}
            zoom={zoom}
            onZoomChange={setZoom}
          />

          <div
            ref={axisRef}
            className="relative h-8 shrink-0 border-b border-border-default bg-bg-subtle"
          >
            {ticks.map((tick) => (
              <div
                key={tick.ms}
                className="absolute top-0 flex h-full flex-col justify-end"
                style={{ left: `${tick.xRatio * 100}%` }}
              >
                <span className="font-data text-data text-text-tertiary -translate-x-1/2 pb-1">
                  {tick.label}
                </span>
              </div>
            ))}
          </div>

          <div
            ref={axisScrollRef}
            className="relative min-h-0 flex-1 overflow-y-auto bg-bg-inset"
            onScroll={(event) => {
              syncScroll('axis', event.currentTarget.scrollTop);
            }}
          >
            <div
              className="relative"
              style={{ height: visibleRange.totalHeight }}
            >
              {ticks.map((tick) => (
                <div
                  key={`grid-${tick.ms}`}
                  className="pointer-events-none absolute top-0 border-l border-border-subtle"
                  style={{
                    left: `${tick.xRatio * 100}%`,
                    height: visibleRange.totalHeight,
                  }}
                />
              ))}

              <div
                style={{
                  transform: `translateY(${visibleRange.offsetTop}px)`,
                }}
              >
                {visibleRows.map((row, index) => (
                  <WaterfallBarRow
                    key={row.spanId}
                    row={row}
                    rowIndex={visibleRange.startIndex + index}
                    zoom={zoom}
                    axisWidth={axisWidth}
                    selected={selectedSpanId === row.spanId}
                    animate={props.animateBars === true}
                    onSelect={() => {
                      if (onSelectSpan !== undefined && row.span !== null) {
                        onSelectSpan(row.spanId);
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WaterfallBarRow(props: {
  readonly row: FlatSpanRow;
  readonly rowIndex: number;
  readonly zoom: ZoomWindow;
  readonly axisWidth: number;
  readonly selected: boolean;
  readonly animate: boolean;
  readonly onSelect: () => void;
}) {
  const row = props.row;
  if (row.span === null) {
    return (
      <div
        className="relative border-b border-border-subtle"
        style={{ height: ROW_HEIGHT }}
      />
    );
  }

  const span = row.span;
  const startX = timeToX(spanStartMs(span), props.zoom, props.axisWidth);
  const endX = timeToX(spanEndMs(span), props.zoom, props.axisWidth);
  const barWidth = Math.max(endX - startX, 2);
  const serviceColor = serviceColorValue(span.resource.serviceName);
  const error = isErrorSpan(span);

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`relative w-full border-b border-border-subtle transition-colors duration-120 hover:bg-bg-raised/40 ${props.selected ? 'bg-accent-subtle/30' : ''}`}
      style={{ height: ROW_HEIGHT }}
    >
      <div
        className={props.animate ? 'waterfall-bar-animated' : undefined}
        style={{
          position: 'absolute',
          top: 4,
          bottom: 4,
          left: startX,
          width: barWidth,
          borderRadius: 2,
          backgroundColor: serviceColor,
          opacity: error ? 0.75 : 0.9,
          outline: props.selected
            ? '1px solid var(--accent)'
            : error
              ? '1px solid var(--status-error)'
              : undefined,
          transformOrigin: 'left center',
          transform: props.animate ? undefined : 'scaleX(1)',
          animation: props.animate
            ? `waterfall-bar-in 160ms ease-out ${props.rowIndex * 8}ms both`
            : undefined,
        }}
      />
      {barWidth > 48 && (
        <span
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 font-data text-data text-text-primary"
          style={{ left: startX + barWidth + 4 }}
        >
          <Duration ms={span.durationMs} />
        </span>
      )}
    </button>
  );
}

function WaterfallTreeRow(props: {
  readonly row: FlatSpanRow;
  readonly selected: boolean;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
}) {
  const row = props.row;
  const span = row.span;
  const indent = row.depth * INDENT_PX;

  if (row.isOrphanRoot) {
    return (
      <div
        className={`flex h-8 items-center gap-1 border-b border-border-subtle px-3 ${props.selected ? 'bg-accent-subtle/30' : ''}`}
        style={{ paddingLeft: 12 + indent }}
      >
        <button
          type="button"
          onClick={props.onToggle}
          className="flex shrink-0 items-center text-text-tertiary transition-colors duration-120 hover:text-text-primary"
        >
          {props.collapsed ? (
            <ChevronRight size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
        </button>
        <span className="truncate text-body text-text-secondary">orphaned</span>
        <span className="font-data text-data text-text-tertiary">
          {row.descendantCount}
        </span>
      </div>
    );
  }

  if (span === null) {
    return null;
  }

  return (
    <div
      className={`flex h-8 items-center gap-1 border-b border-border-subtle px-3 transition-colors duration-120 hover:bg-bg-raised ${props.selected ? 'bg-accent-subtle/30' : ''}`}
      style={{ paddingLeft: 12 + indent }}
    >
      {row.hasChildren ? (
        <button
          type="button"
          onClick={props.onToggle}
          className="flex shrink-0 items-center text-text-tertiary transition-colors duration-120 hover:text-text-primary"
        >
          {props.collapsed ? (
            <ChevronRight size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <button
        type="button"
        onClick={props.onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="truncate text-body text-text-primary">
          {span.name}
        </span>
        <ServiceBadge name={span.resource.serviceName} />
        {isErrorSpan(span) && <StatusBadge status="error" />}
      </button>
      {row.hasChildren && (
        <span className="shrink-0 font-data text-data text-text-tertiary">
          {row.descendantCount}
        </span>
      )}
    </div>
  );
}

export { ORPHAN_ROOT_ID, ROW_HEIGHT };
