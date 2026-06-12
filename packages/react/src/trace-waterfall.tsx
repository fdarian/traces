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

const ROW_HEIGHT = 32;
const TREE_MIN_WIDTH = 280;
const AXIS_MIN_WIDTH = 320;
const INDENT_PX = 16;

function spanEndMs(span: Span): number {
  return normalizeTimestampToMs(span.endTimeUnixNano);
}

function isErrorSpan(span: Span): boolean {
  return span.status.code === 'error';
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
  const [axisWidth, setAxisWidth] = useState(AXIS_MIN_WIDTH);
  const [internalCollapsed, setInternalCollapsed] = useState(
    () => new Set<string>(),
  );
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

  return (
    <div className="flex min-h-0 flex-1 flex-col border border-border-subtle bg-bg-subtle">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="shrink-0 overflow-y-auto border-r border-border-subtle"
          style={{ minWidth: TREE_MIN_WIDTH, width: '38%' }}
        >
          <div className="sticky top-0 z-10 flex h-8 items-center border-b border-border-default bg-bg-subtle px-3 text-label uppercase tracking-wide text-text-tertiary">
            span
          </div>
          {rows.map((row) => (
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

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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

          <div className="relative min-h-0 flex-1 overflow-y-auto bg-bg-inset">
            {ticks.map((tick) => (
              <div
                key={`grid-${tick.ms}`}
                className="pointer-events-none absolute top-0 bottom-0 border-l border-border-subtle"
                style={{ left: `${tick.xRatio * 100}%` }}
              />
            ))}

            {rows.map((row, index) => {
              if (row.span === null) {
                return (
                  <div
                    key={row.spanId}
                    className="relative border-b border-border-subtle"
                    style={{ height: ROW_HEIGHT }}
                  />
                );
              }
              const span = row.span;
              const startX = timeToX(spanStartMs(span), zoom, axisWidth);
              const endX = timeToX(spanEndMs(span), zoom, axisWidth);
              const barWidth = Math.max(endX - startX, 2);
              const serviceColor = serviceColorValue(span.resource.serviceName);
              const error = isErrorSpan(span);
              const selected = selectedSpanId === row.spanId;
              const animate = props.animateBars === true;

              return (
                <button
                  key={row.spanId}
                  type="button"
                  onClick={() => {
                    if (onSelectSpan !== undefined) {
                      onSelectSpan(row.spanId);
                    }
                  }}
                  className={`relative w-full border-b border-border-subtle transition-colors duration-120 hover:bg-bg-raised/40 ${selected ? 'bg-accent-subtle/30' : ''}`}
                  style={{ height: ROW_HEIGHT }}
                >
                  <div
                    className={animate ? 'waterfall-bar-animated' : undefined}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      left: startX,
                      width: barWidth,
                      borderRadius: 2,
                      backgroundColor: serviceColor,
                      opacity: error ? 0.75 : 0.9,
                      outline: selected
                        ? '1px solid var(--accent)'
                        : error
                          ? '1px solid var(--status-error)'
                          : undefined,
                      transformOrigin: 'left center',
                      transform: animate ? undefined : 'scaleX(1)',
                      animation: animate
                        ? `waterfall-bar-in 160ms ease-out ${index * 8}ms both`
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
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function WaterfallTreeRow(props: {
  readonly row: ReturnType<typeof flattenSpanTree>[number];
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
