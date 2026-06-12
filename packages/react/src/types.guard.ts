/**
 * Compile-time drift guard: the SDK ships a self-contained copy of the core
 * domain types in `./types.ts` (so consumers never need to install the
 * workspace-only `@traces/core`). This file is NOT part of the published entry
 * — it is never imported by `index.ts`, so it stays out of the bundle and the
 * emitted `.d.ts`. It exists only so `tsc --noEmit` fails if the local copy
 * structurally diverges from `@traces/core`'s model.
 */
import type * as Core from '@traces/core';
import type {
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
} from './types.js';

/** Asserts `A` and `B` are mutually assignable (structurally equal). */
type AssertEqual<A extends B, B extends C, C = A> = true;

type Checks = [
  AssertEqual<AttributeValue, Core.AttributeValue>,
  AssertEqual<SpanEvent, Core.SpanEvent>,
  AssertEqual<ExceptionInfo, Core.ExceptionInfo>,
  AssertEqual<SpanStatus, Core.SpanStatus>,
  AssertEqual<SpanResource, Core.SpanResource>,
  AssertEqual<StatusCode, Core.StatusCode>,
  AssertEqual<Span, Core.Span>,
  AssertEqual<Trace, Core.Trace>,
  AssertEqual<TraceSummaryService, Core.TraceSummaryService>,
  AssertEqual<TraceSummary, Core.TraceSummary>,
];

export type _DriftGuard = Checks;
