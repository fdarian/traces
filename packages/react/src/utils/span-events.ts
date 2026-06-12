import type { Span, SpanEvent } from '@traces/core';
import { spanStartMs } from './span-tree.js';

export function eventOffsetMs(event: SpanEvent, span: Span): number {
  return event.timestamp - spanStartMs(span);
}
