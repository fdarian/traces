import { hashFingerprint } from '../issues/fingerprint.js';
import { normalizeExceptionMessage } from '../issues/normalize-message.js';
import type { LogRecord } from './model.js';

export interface ErrorGroup {
  readonly fingerprint: string;
  readonly service: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly deploymentIds: ReadonlyArray<string>;
  /** Full message of the first record seen in the group. */
  readonly sample: string;
  /** Trace id of the first record in the group that carries one, to jump into the trace. */
  readonly traceId?: string;
}

export const firstLine = (message: string): string => {
  const line = message.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
};

export const errorFingerprint = (record: LogRecord): string =>
  hashFingerprint([
    record.service,
    normalizeExceptionMessage(firstLine(record.message)),
  ]);

/** Groups by service and normalized first line (ids and numbers collapsed), most frequent first. Records of several services may be passed together. */
export const groupErrors = (
  records: ReadonlyArray<LogRecord>,
): ReadonlyArray<ErrorGroup> => {
  const groups = new Map<
    string,
    {
      fingerprint: string;
      service: string;
      count: number;
      firstSeen: string;
      lastSeen: string;
      deploymentIds: Set<string>;
      sample: string;
      traceId?: string;
    }
  >();
  for (const record of records) {
    const fingerprint = errorFingerprint(record);
    const existing = groups.get(fingerprint);
    if (existing === undefined) {
      groups.set(fingerprint, {
        fingerprint,
        service: record.service,
        count: 1,
        firstSeen: record.ts,
        lastSeen: record.ts,
        deploymentIds: new Set(
          record.deploymentId === undefined ? [] : [record.deploymentId],
        ),
        sample: record.message,
        ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
      });
      continue;
    }
    existing.count += 1;
    if (record.ts < existing.firstSeen) existing.firstSeen = record.ts;
    if (record.ts > existing.lastSeen) existing.lastSeen = record.ts;
    if (record.deploymentId !== undefined) {
      existing.deploymentIds.add(record.deploymentId);
    }
    if (existing.traceId === undefined && record.traceId !== undefined) {
      existing.traceId = record.traceId;
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      deploymentIds: [...group.deploymentIds],
    }))
    .sort(
      (left, right) =>
        right.count - left.count || right.lastSeen.localeCompare(left.lastSeen),
    );
};
