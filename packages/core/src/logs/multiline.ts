import type { LogLevel, LogRecord } from './model.js';

/** Railway emits each line of one `console.error` as its own record, stamped within a few ms of each other. */
export const MULTILINE_GAP_MS = 50;
export const MULTILINE_SAMPLE_LINES = 20;

/** An event and the number of log lines it was merged from, which is what grep counts. */
export type Coalesced = LogRecord & { readonly lines: number };

const levelClass = (level: LogLevel): LogLevel =>
  level === 'fatal' ? 'error' : level;

interface OpenEvent {
  readonly record: LogRecord;
  readonly lines: Array<string>;
  merged: boolean;
  hasHeadline: boolean;
  lastTs: number;
  traceId: string | undefined;
}

const CONTINUATION = /^(\s|\}|\]|at |\d+ \| )/;

/** A bare `{` or `[` opens an object dump from `console.error("msg", obj)`, so it stays with its message. */
const isContinuation = (line: string): boolean =>
  line === '' || line === '{' || line === '[' || CONTINUATION.test(line);

const containsHeadline = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) => !isContinuation(line));

/**
 * Same-microsecond records can arrive out of order, and Bun prints source
 * snippets (`370 | status: 404,`) ahead of the error, so the first line of an
 * event is not always its headline. The headline moves to the front; when
 * every line is a continuation the first line stays.
 */
const withHeadlineFirst = (lines: ReadonlyArray<string>): Array<string> => {
  const index = lines.findIndex((line) => !isContinuation(line));
  if (index <= 0) return [...lines];
  return [
    ...lines.slice(index, index + 1),
    ...lines.slice(0, index),
    ...lines.slice(index + 1),
  ];
};

const eventKey = (record: LogRecord): string =>
  JSON.stringify([
    record.service,
    record.deploymentId,
    levelClass(record.level),
  ]);

/**
 * Merges consecutive records of one service and deployment, at the same level
 * class and each within `MULTILINE_GAP_MS` of the one before, into a single
 * record: the first record's fields with the lines joined into `message`
 * (capped), headline line first, so a stack trace or object dump groups under
 * its headline.
 *
 * Within the gap, a record whose first line is a continuation (indented, `at`,
 * a closing bracket, a bare `{` or `[`, a Bun `370 | ...` snippet) always
 * merges. A record whose first line is a headline merges only while the open
 * event has no headline yet (Bun prints snippets before the error); otherwise
 * it starts a new event, so a burst of distinct errors stays distinct.
 * Events open per service/deployment/level, so interleaved deployments do not
 * split each other's events. Output follows each event's first record.
 */
export const coalesceMultiline = (
  records: ReadonlyArray<LogRecord>,
): ReadonlyArray<Coalesced> => {
  const events: Array<OpenEvent> = [];
  const open = new Map<string, OpenEvent>();
  for (const record of records) {
    const key = eventKey(record);
    const ts = Date.parse(record.ts);
    if (Number.isNaN(ts)) {
      throw new Error(`log record has an invalid timestamp "${record.ts}"`);
    }
    const lines = record.message.split('\n');
    const event = open.get(key);
    const startsHeadline = containsHeadline(lines.slice(0, 1));
    if (
      event !== undefined &&
      ts - event.lastTs <= MULTILINE_GAP_MS &&
      !(startsHeadline && event.hasHeadline)
    ) {
      event.lines.push(...lines);
      event.merged = true;
      event.hasHeadline ||= containsHeadline(lines);
      event.lastTs = ts;
      event.traceId ??= record.traceId;
      continue;
    }
    const created: OpenEvent = {
      record,
      lines: [...lines],
      merged: false,
      hasHeadline: containsHeadline(lines),
      lastTs: ts,
      traceId: record.traceId,
    };
    events.push(created);
    open.set(key, created);
  }
  return events.map((event) => {
    if (!event.merged) {
      return { ...event.record, lines: event.lines.length };
    }
    const message = withHeadlineFirst(event.lines)
      .slice(0, MULTILINE_SAMPLE_LINES)
      .join('\n');
    return {
      ...event.record,
      message,
      lines: event.lines.length,
      ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    };
  });
};
