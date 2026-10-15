import { createHash } from 'node:crypto';
import { Option, Schema } from 'effect';
import type { LogLevel, LogRecord } from './model.js';

const ANSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);

export const stripAnsi = (text: string): string =>
  text.replace(ANSI_PATTERN, '');

export const normalizeLevel = (raw: string | null | undefined): LogLevel => {
  if (raw === null || raw === undefined) return 'unknown';
  switch (raw.toLowerCase()) {
    case 'trace':
    case 'debug':
      return 'debug';
    case 'info':
    case 'log':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'err':
    case 'error':
      return 'error';
    case 'fatal':
    case 'critical':
    case 'panic':
      return 'fatal';
    default:
      return 'unknown';
  }
};

export const shortHash = (text: string): string =>
  createHash('sha1').update(text).digest('hex').slice(0, 10);

const UnknownFromJson = Schema.fromJsonString(Schema.Unknown);

/** Railway attribute values are JSON-encoded; one that is not valid JSON stays the raw string. */
export const decodeJsonAttribute = (value: string): unknown => {
  const decoded = Schema.decodeUnknownOption(UnknownFromJson)(value);
  return Option.isNone(decoded) ? value : decoded.value;
};

const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;

const idOf = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const firstId = (
  sources: ReadonlyArray<Record<string, unknown> | undefined>,
  keys: ReadonlyArray<string>,
  pattern: RegExp,
): string | undefined => {
  for (const source of sources) {
    if (source === undefined) continue;
    for (const key of keys) {
      const id = idOf(source[key], pattern);
      if (id !== undefined) return id;
    }
  }
  return undefined;
};

/**
 * Looks in `attrs.annotations` (Effect loggers) first, then top-level attrs
 * (other loggers). Only well-formed ids are promoted, so a stray `traceId`
 * attribute of another shape stays in `attrs`.
 */
export const traceContextOf = (
  attrs: Readonly<Record<string, unknown>>,
): { readonly traceId?: string; readonly spanId?: string } => {
  const sources = [asRecord(attrs.annotations), attrs];
  const traceId = firstId(sources, ['traceId', 'trace_id'], TRACE_ID);
  const spanId = firstId(sources, ['spanId', 'span_id'], SPAN_ID);
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  };
};

export const levelAllowed = (
  levels: ReadonlyArray<LogLevel>,
  record: LogRecord,
): boolean => levels.length === 0 || levels.includes(record.level);

export const matchesGrep = (
  grep: string | undefined,
  record: LogRecord,
): boolean =>
  grep === undefined ||
  record.message.toLowerCase().includes(grep.toLowerCase());

export const sortableIso = (ts: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(ts);
  if (match === null) return ts;
  const fraction = match[2] === undefined ? '' : match[2];
  return `${match[1]}.${fraction.padEnd(9, '0')}Z`;
};

export const floorMs = (ts: string): number => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(ts);
  if (match === null) return Date.parse(ts);
  const fraction = match[2] === undefined ? '' : match[2];
  return Date.parse(`${match[1]}.${fraction.padEnd(3, '0').slice(0, 3)}Z`);
};
