import type { TraceSummary } from '@traces/core';
import type { CountedTrace } from '#/service-stats/store';

const NS_PER_MS = BigInt(1_000_000);
const SUB_MS_NS_DIGITS = '999999';

export interface StepPolicy {
  readonly minStepMs: number;
  readonly maxStepMs: number;
}

export type LimitOutcome =
  | { readonly kind: 'halve'; readonly stepMs: number }
  | { readonly kind: 'gap' };

export interface StepInterval {
  readonly startMs: number;
  readonly endMs: number;
}

export function initialStepMs(preferredMs: number, policy: StepPolicy): number {
  return Math.min(policy.maxStepMs, Math.max(policy.minStepMs, preferredMs));
}

export function stepAfterCleanResult(
  stepMs: number,
  policy: StepPolicy,
): number {
  return Math.min(stepMs * 2, policy.maxStepMs);
}

/**
 * Halving is based on the interval actually searched, which `end` may have cut
 * below the step; an interval already at the floor can't shrink, so it becomes a gap.
 */
export function onLimitHit(
  stepMs: number,
  interval: StepInterval,
  policy: StepPolicy,
): LimitOutcome {
  const widthMs = interval.endMs - interval.startMs;
  if (widthMs <= policy.minStepMs) {
    return { kind: 'gap' };
  }
  const halved = Math.floor(Math.min(stepMs, widthMs) / 2);
  return { kind: 'halve', stepMs: Math.max(policy.minStepMs, halved) };
}

/** Null when `[forwardMs, endMs)` is empty, which must never be sent to Jaeger. */
export function computeInterval(
  forwardMs: number,
  stepMs: number,
  endMs: number,
): StepInterval | null {
  const intervalEnd = Math.min(forwardMs + stepMs, endMs);
  if (intervalEnd <= forwardMs) {
    return null;
  }
  return { startMs: forwardMs, endMs: intervalEnd };
}

export function toCountedTrace(summary: TraceSummary): CountedTrace {
  return {
    traceId: summary.traceId,
    startMs: Number(BigInt(summary.startTimeUnixNano) / NS_PER_MS),
    durationMs: summary.durationMs,
    errorSpanCount:
      summary.errorSpanCount === undefined ? 0 : summary.errorSpanCount,
    rootService: summary.rootService,
    rootOperation: summary.rootOperation,
    spanCount: summary.spanCount,
  };
}

export function formatStartTimeMin(startMs: number): string {
  return new Date(startMs).toISOString();
}

/**
 * RFC3339Nano for `endMs − 1 ns`. Jaeger's bounds are inclusive, so this keeps
 * adjacent intervals from sharing an instant.
 */
export function formatStartTimeMax(endMs: number): string {
  const iso = new Date(endMs - 1).toISOString();
  return `${iso.slice(0, -1)}${SUB_MS_NS_DIGITS}Z`;
}
