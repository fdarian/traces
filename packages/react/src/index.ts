// components

// types (re-exported from @traces/core)
export type {
  AttributeValue,
  ExceptionInfo,
  Span,
  SpanEvent,
  SpanResource,
  SpanStatus,
  StatusCode,
  Trace,
  TraceSummary,
  TraceSummaryService,
} from '@traces/core';
export { CopyText } from './copy-text.js';
export { Duration } from './duration.js';
export { EmptyState } from './empty-state.js';
export type { IssueDetailData, IssueOccurrenceRow } from './issue-detail.js';
export { IssueDetail } from './issue-detail.js';
export type { IssueListRow } from './issue-list-table.js';
export { IssueListTable } from './issue-list-table.js';
// formatters
export { ServiceBadge, serviceColorValue } from './service-badge.js';
export { SkeletonRow } from './skeleton-row.js';
export { SpanDetailPanel } from './span-detail-panel.js';
export { fillHistogramCounts, Sparkline } from './sparkline.js';
export type { StackFrame } from './stacktrace-block.js';
export { parseStackFrames, StacktraceBlock } from './stacktrace-block.js';
export type { Status } from './status-badge.js';
export { StatusBadge } from './status-badge.js';
export { TraceDetailView } from './trace-detail-view.js';
export { TraceListTable } from './trace-list-table.js';
export { TraceWaterfall } from './trace-waterfall.js';
// utils
export type { FlatSpanRow, SpanTreeNode } from './utils/span-tree.js';
export {
  buildSpanTree,
  collectDefaultCollapsed,
  flattenSpanTree,
  ORPHAN_ROOT_ID,
  spanStartMs,
} from './utils/span-tree.js';
export { normalizeTimestampToMs } from './utils/time.js';
export type { TimeBounds, TimeTick, ZoomWindow } from './utils/time-scale.js';
export {
  clampZoomWindow,
  computeTraceTimeBounds,
  formatTickLabel,
  generateTimeTicks,
  timeToX,
  xToTime,
} from './utils/time-scale.js';
