import type { Span, SpanEvent } from '../types.js';
import { spanStartMs } from './span-tree.js';

export function eventOffsetMs(event: SpanEvent, span: Span): number {
  return event.timestamp - spanStartMs(span);
}
