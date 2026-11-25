import type { ErrorGroup, LogRecord } from '@traces/core';
import { baselineKey, isoSeconds } from '#/deploy-window.ts';

/** A service whose counts cover only the newest part of the window because a read cap was hit. */
export interface PartialCoverage {
  readonly source: 'logs' | 'traces';
  readonly service: string;
  /** Where the counts start: the oldest record or trace they include. */
  readonly countedSince: string;
  /** Where the window the user asked for starts. */
  readonly since: Date;
  /** What was capped, as a clause of the note. */
  readonly cap: string;
}

const instant = (value: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`countedSince "${value}" is not a timestamp`);
  }
  return date;
};

/** Log pages come newest first or oldest first depending on the provider, so the oldest record is found, not assumed. */
export const oldestLogTs = (records: ReadonlyArray<LogRecord>): string => {
  const first = records[0];
  if (first === undefined) {
    throw new Error('a capped log page has no records');
  }
  return records.reduce(
    (oldest, record) =>
      Date.parse(record.ts) < Date.parse(oldest) ? record.ts : oldest,
    first.ts,
  );
};

const logCoverage = (
  service: {
    readonly name: string;
    readonly since: Date;
    readonly page: {
      readonly records: ReadonlyArray<LogRecord>;
      readonly next?: unknown;
    };
  },
  cap: number,
): PartialCoverage | undefined =>
  service.page.next === undefined
    ? undefined
    : {
        source: 'logs',
        service: service.name,
        countedSince: oldestLogTs(service.page.records),
        since: service.since,
        cap: `hit the ${cap}-log cap`,
      };

const traceCoverage = (
  outcome: {
    readonly name: string;
    readonly since: Date;
    readonly scan: {
      readonly partial: boolean;
      readonly countedSince?: string;
      readonly errorTraces: number;
      readonly scanned: number;
    };
  },
  caps: { readonly errorTraces: number; readonly scanned: number },
): PartialCoverage | undefined => {
  if (!outcome.scan.partial) return undefined;
  if (outcome.scan.countedSince === undefined) {
    throw new Error(
      `partial trace scan of "${outcome.name}" has no countedSince`,
    );
  }
  return {
    source: 'traces',
    service: outcome.name,
    countedSince: outcome.scan.countedSince,
    since: outcome.since,
    cap: `trace scan was capped (${caps.errorTraces} error traces or ${caps.scanned} traces scanned per service) after reading ${outcome.scan.errorTraces} error traces out of ${outcome.scan.scanned} scanned`,
  };
};

/** `labelled` is true when several services print notes, so the line says whose counts these are. */
export const coverageNote = (
  coverage: PartialCoverage,
  until: Date,
  labelled: boolean,
): string => {
  const origin = coverage.source === 'traces' ? ' (traces)' : '';
  const prefix = labelled ? `${coverage.service}${origin}: ` : '';
  return `note: ${prefix}${coverage.cap}; counts cover ${isoSeconds(instant(coverage.countedSince))} -> ${isoSeconds(until)}, not the whole window from ${isoSeconds(coverage.since)}. Narrow --since for exact counts.`;
};

/** Keyed like the baselines: a service's log and trace counts are capped independently. */
export const collectCoverage = (
  fetched: ReadonlyArray<Parameters<typeof logCoverage>[0]>,
  scanned: ReadonlyArray<Parameters<typeof traceCoverage>[0]>,
  caps: {
    readonly logs: number;
    readonly errorTraces: number;
    readonly scanned: number;
  },
): ReadonlyMap<string, PartialCoverage> => {
  const found = [
    ...fetched.map((service) => logCoverage(service, caps.logs)),
    ...scanned.map((outcome) => traceCoverage(outcome, caps)),
  ].filter((coverage) => coverage !== undefined);
  return new Map(found.map((coverage) => [baselineKey(coverage), coverage]));
};

export const partialFields = (
  coverages: ReadonlyMap<string, PartialCoverage>,
  group: ErrorGroup,
) => {
  const coverage = coverages.get(baselineKey(group));
  return coverage === undefined
    ? { partial: false }
    : { partial: true, countedSince: coverage.countedSince };
};
