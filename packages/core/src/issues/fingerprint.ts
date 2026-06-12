import { createHash } from 'node:crypto';
import type { ExceptionInfo, Span } from '../model.js';
import { normalizeExceptionMessage } from './normalize-message.js';
import { parseTopInAppStackFrame } from './stack-frame.js';

export function hashFingerprint(parts: ReadonlyArray<string>): string {
  const key = parts.join('\0');
  return createHash('sha256').update(key).digest('hex');
}

export function buildIssueTitle(
  exceptionType: string,
  message: string,
): string {
  const condensed =
    message.length > 80 ? `${message.slice(0, 77)}...` : message;
  return `${exceptionType}: ${condensed}`;
}

export function fingerprintFromException(
  service: string,
  exception: ExceptionInfo,
): string {
  const normalizedMessage = normalizeExceptionMessage(exception.message);
  const topFrame = parseTopInAppStackFrame(exception.stacktrace);
  const parts: Array<string> = [service, exception.type, normalizedMessage];
  if (topFrame !== null) {
    parts.push(topFrame);
  }
  return hashFingerprint(parts);
}

export function fingerprintFromErrorSpan(span: Span): string {
  const service = span.resource.serviceName;
  const parts: Array<string> = [service, span.name];
  if (span.status.message !== undefined && span.status.message !== '') {
    parts.push(normalizeExceptionMessage(span.status.message));
  }
  return hashFingerprint(parts);
}
