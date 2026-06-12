import type { Span } from '@traces/core';
import type { PointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { serviceColorValue } from './service-badge.js';
import { spanStartMs } from './utils/span-tree.js';
import { normalizeTimestampToMs } from './utils/time.js';
import {
  clampZoomWindow,
  computeTraceTimeBounds,
  timeToX,
  xToTime,
  type ZoomWindow,
} from './utils/time-scale.js';

const MINIMAP_HEIGHT = 40;
const MIN_ZOOM_MS = 5;

function spanEndMs(span: Span): number {
  return normalizeTimestampToMs(span.endTimeUnixNano);
}

export function WaterfallMinimap(props: {
  readonly spans: ReadonlyArray<Span>;
  readonly zoom: ZoomWindow;
  readonly onZoomChange: (zoom: ZoomWindow) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bounds = computeTraceTimeBounds(props.spans);
  const [width, setWidth] = useState(1);
  const [brush, setBrush] = useState<{
    readonly startX: number;
    readonly endX: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const brushLeft = brush !== null ? Math.min(brush.startX, brush.endX) : 0;
  const brushWidth = brush !== null ? Math.abs(brush.endX - brush.startX) : 0;

  const zoomLeft = timeToX(props.zoom.startMs, bounds, width);
  const zoomRight = timeToX(props.zoom.endMs, bounds, width);
  const zoomWidth = Math.max(zoomRight - zoomLeft, 1);

  const brushRef = useRef<{
    readonly startX: number;
    readonly endX: number;
  } | null>(null);

  const pointerX = (event: PointerEvent<HTMLDivElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined) {
      return 0;
    }
    const x = event.clientX - rect.left;
    if (x < 0) {
      return 0;
    }
    if (x > rect.width) {
      return rect.width;
    }
    return x;
  };

  const applyBrush = (startX: number, endX: number, mapWidthPx: number) => {
    if (mapWidthPx < 4) {
      return;
    }
    const fullWindow = { startMs: bounds.startMs, endMs: bounds.endMs };
    const startMs = xToTime(Math.min(startX, endX), fullWindow, mapWidthPx);
    const endMs = xToTime(Math.max(startX, endX), fullWindow, mapWidthPx);
    const next = clampZoomWindow({ startMs, endMs }, bounds, MIN_ZOOM_MS);
    props.onZoomChange(next);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const x = pointerX(event);
    setDragging(true);
    const next = { startX: x, endX: x };
    brushRef.current = next;
    setBrush(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) {
      return;
    }
    const x = pointerX(event);
    const current = brushRef.current;
    const next =
      current === null
        ? { startX: x, endX: x }
        : { startX: current.startX, endX: x };
    brushRef.current = next;
    setBrush(next);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) {
      return;
    }
    setDragging(false);
    const element = ref.current;
    const current = brushRef.current;
    if (element !== null && current !== null) {
      applyBrush(current.startX, current.endX, element.clientWidth);
    }
    brushRef.current = null;
    setBrush(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleDoubleClick = () => {
    props.onZoomChange({
      startMs: bounds.startMs,
      endMs: bounds.endMs,
    });
  };

  return (
    <div
      ref={ref}
      className="relative shrink-0 cursor-crosshair border-b border-border-default bg-bg-inset"
      style={{ height: MINIMAP_HEIGHT }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      {props.spans.map((span) => {
        const left = timeToX(spanStartMs(span), bounds, width);
        const right = timeToX(spanEndMs(span), bounds, width);
        const barWidth = Math.max(right - left, 1);
        const color = serviceColorValue(span.resource.serviceName);
        const error = span.status.code === 'error';
        return (
          <div
            key={span.spanId}
            className="pointer-events-none absolute top-2 bottom-2 rounded-sm"
            style={{
              left,
              width: barWidth,
              backgroundColor: color,
              opacity: error ? 0.85 : 0.55,
            }}
          />
        );
      })}

      <div
        className="pointer-events-none absolute top-0 bottom-0 border border-border-strong bg-accent-subtle/20"
        style={{
          left: zoomLeft,
          width: zoomWidth,
        }}
      />

      {brush !== null && brushWidth > 0 && (
        <div
          className="pointer-events-none absolute top-0 bottom-0 border border-accent bg-accent-subtle/40"
          style={{
            left: brushLeft,
            width: brushWidth,
          }}
        />
      )}
    </div>
  );
}

export { MINIMAP_HEIGHT };
