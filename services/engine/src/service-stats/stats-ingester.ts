import { TraceBackend } from '@traces/core';
import {
  Cause,
  Clock,
  Config,
  Effect,
  Fiber,
  Layer,
  Ref,
  Schedule,
} from 'effect';
import { excludedServicesConfig } from '#/issues/excluded-services';
import {
  computeInterval,
  formatStartTimeMax,
  formatStartTimeMin,
  initialStepMs,
  onLimitHit,
  type StepPolicy,
  stepAfterCleanResult,
  toCountedTrace,
} from '#/service-stats/stats-step';
import { MINUTE_MS, ServiceStatsStore } from '#/service-stats/store';

const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_SETTLE_MS = 60_000;
const DEFAULT_TRACE_LIMIT = 1000;
const DEFAULT_MIN_STEP_MS = 5000;
const DEFAULT_MAX_STEP_MS = 900_000;
const DEFAULT_INITIAL_LOOKBACK_MS = 3_600_000;
const DEFAULT_TICK_TRACE_BUDGET = 5000;
const DEFAULT_MINUTE_RETENTION_MS = 26 * HOUR_MS;
const DEFAULT_HOUR_RETENTION_MS = 15 * 24 * HOUR_MS;
const INITIAL_STEP_MS = 5 * MINUTE_MS;
const PRUNE_INTERVAL_MS = 10 * MINUTE_MS;
const CAUGHT_UP_MARGIN_MS = 1000;

const numberWithDefault = (name: string, fallback: number) =>
  Config.Number(name).pipe(Config.withDefault(fallback));

export const statsIngesterConfig = Config.all({
  pollIntervalMs: numberWithDefault(
    'STATS_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
  ),
  settleMs: numberWithDefault('STATS_SETTLE_MS', DEFAULT_SETTLE_MS),
  traceLimit: numberWithDefault('STATS_TRACE_LIMIT', DEFAULT_TRACE_LIMIT),
  minStepMs: numberWithDefault('STATS_MIN_STEP_MS', DEFAULT_MIN_STEP_MS),
  maxStepMs: numberWithDefault('STATS_MAX_STEP_MS', DEFAULT_MAX_STEP_MS),
  initialLookbackMs: numberWithDefault(
    'STATS_INITIAL_LOOKBACK_MS',
    DEFAULT_INITIAL_LOOKBACK_MS,
  ),
  tickTraceBudget: numberWithDefault(
    'STATS_TICK_TRACE_BUDGET',
    DEFAULT_TICK_TRACE_BUDGET,
  ),
  minuteRetentionMs: numberWithDefault(
    'STATS_MINUTE_RETENTION_MS',
    DEFAULT_MINUTE_RETENTION_MS,
  ),
  hourRetentionMs: numberWithDefault(
    'STATS_HOUR_RETENTION_MS',
    DEFAULT_HOUR_RETENTION_MS,
  ),
  excludedServices: excludedServicesConfig,
});

export type StatsIngesterSettings = Config.Success<typeof statsIngesterConfig>;

interface StatsRefs {
  readonly stepsByService: Ref.Ref<Map<string, number>>;
  readonly lastPruneMs: Ref.Ref<number | null>;
}

interface Position {
  readonly forwardMs: number;
  readonly expectedForwardMs: number | null;
  readonly startedMs: number;
}

const ingestService = (
  service: string,
  settings: StatsIngesterSettings,
  traceBudget: number,
  stepsByService: Ref.Ref<Map<string, number>>,
) =>
  Effect.gen(function* () {
    const backend = yield* TraceBackend;
    const store = yield* ServiceStatsStore;
    const policy: StepPolicy = {
      minStepMs: settings.minStepMs,
      maxStepMs: settings.maxStepMs,
    };

    const knownStepMs = (yield* Ref.get(stepsByService)).get(service);
    let stepMs =
      knownStepMs === undefined
        ? initialStepMs(INITIAL_STEP_MS, policy)
        : knownStepMs;
    const saveStep = Ref.update(stepsByService, (steps) =>
      new Map(steps).set(service, stepMs),
    );

    const cursor = yield* store.getCursor(service);
    let position: Position | null =
      cursor === null
        ? null
        : {
            forwardMs: cursor.forwardMs,
            expectedForwardMs: cursor.forwardMs,
            startedMs: cursor.startedMs,
          };
    let remainingTraces = traceBudget;

    while (remainingTraces > 0) {
      const nowMs = yield* Clock.currentTimeMillis;
      const endMs = nowMs - settings.settleMs;
      if (position === null) {
        const startMs = endMs - settings.initialLookbackMs;
        position = {
          forwardMs: startMs,
          expectedForwardMs: null,
          startedMs: startMs,
        };
      }
      if (position.forwardMs >= endMs - CAUGHT_UP_MARGIN_MS) {
        break;
      }
      const interval = computeInterval(position.forwardMs, stepMs, endMs);
      if (interval === null) {
        break;
      }

      const summaries = yield* backend.searchTraces({
        service,
        startTimeMin: formatStartTimeMin(interval.startMs),
        startTimeMax: formatStartTimeMax(interval.endMs),
        limit: settings.traceLimit,
      });
      remainingTraces -= summaries.length;

      let gap: { startMs: number; endMs: number } | null = null;
      const hitLimit = summaries.length >= settings.traceLimit;
      if (hitLimit) {
        const outcome = onLimitHit(stepMs, interval, policy);
        if (outcome.kind === 'halve') {
          stepMs = outcome.stepMs;
          yield* saveStep;
          continue;
        }
        gap = { startMs: interval.startMs, endMs: interval.endMs };
        stepMs = policy.minStepMs;
        yield* Effect.logWarning(
          `stats step hit the trace limit at the minimum step; counting a sample for [${interval.startMs}, ${interval.endMs})`,
        );
      } else {
        stepMs = stepAfterCleanResult(stepMs, policy);
      }

      const committed = yield* store.commitStep({
        service,
        expectedForwardMs: position.expectedForwardMs,
        startedMs: position.startedMs,
        newForwardMs: interval.endMs,
        nowMs,
        traces: summaries.map(toCountedTrace),
        gap,
      });
      yield* saveStep;
      if (committed === 'conflict') {
        yield* Effect.logWarning(
          'stats cursor moved under this pass; another writer is active',
        );
        break;
      }
      position = {
        forwardMs: interval.endMs,
        expectedForwardMs: interval.endMs,
        startedMs: position.startedMs,
      };
    }
  });

const pruneIfDue = (settings: StatsIngesterSettings, refs: StatsRefs) =>
  Effect.gen(function* () {
    const store = yield* ServiceStatsStore;
    const nowMs = yield* Clock.currentTimeMillis;
    const lastPruneMs = yield* Ref.get(refs.lastPruneMs);
    if (lastPruneMs !== null && nowMs - lastPruneMs < PRUNE_INTERVAL_MS) {
      return;
    }
    yield* store.prune({
      nowMs,
      minuteRetentionMs: settings.minuteRetentionMs,
      hourRetentionMs: settings.hourRetentionMs,
    });
    yield* Ref.set(refs.lastPruneMs, nowMs);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError('stats prune failed', Cause.fail(error)),
    ),
  );

const statsTick = (settings: StatsIngesterSettings, refs: StatsRefs) =>
  Effect.gen(function* () {
    const backend = yield* TraceBackend;
    const allServices = yield* backend.listServices;
    const services = allServices.filter(
      (service) => !settings.excludedServices.has(service),
    );
    const perServiceBudget = Math.max(
      settings.traceLimit,
      Math.floor(settings.tickTraceBudget / Math.max(1, services.length)),
    );

    for (const service of services) {
      yield* ingestService(
        service,
        settings,
        perServiceBudget,
        refs.stepsByService,
      ).pipe(
        Effect.catch((error) =>
          Effect.logError('stats pass failed', Cause.fail(error)).pipe(
            Effect.annotateLogs({ service }),
          ),
        ),
      );
    }

    yield* pruneIfDue(settings, refs);
  });

const makeRefs = Effect.gen(function* () {
  return {
    stepsByService: yield* Ref.make(new Map<string, number>()),
    lastPruneMs: yield* Ref.make<number | null>(null),
  };
});

/** One tick with fresh in-memory state; the building block tests drive directly. */
export const runStatsTickOnce = Effect.gen(function* () {
  const settings = yield* statsIngesterConfig;
  return yield* statsTick(settings, yield* makeRefs);
});

export const runStatsIngester = Effect.gen(function* () {
  const settings = yield* statsIngesterConfig;
  const refs = yield* makeRefs;
  return statsTick(settings, refs).pipe(
    Effect.catchCause((cause) =>
      Effect.logError('stats ingester tick failed', cause),
    ),
    Effect.repeat(Schedule.spaced(settings.pollIntervalMs)),
  );
});

export const StatsIngesterLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const program = yield* runStatsIngester;
    const fiber = yield* Effect.forkScoped(program);
    yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
  }),
);
