import { normalizeExceptionMessage } from './normalize-message.js';

const FRAME_LINE_PATTERN = /^\s*at\s+(.+)$/;
const PAREN_FRAME_PATTERN = /\(([^)]+)\)/;
const BARE_LOCATION_PATTERN = /^\S.+:\d+:\d+$/;

function isInAppFrame(location: string): boolean {
  if (location.includes('node_modules')) {
    return false;
  }
  if (location.includes('node:internal')) {
    return false;
  }
  return true;
}

function normalizeFrameLocation(location: string): string {
  return normalizeExceptionMessage(location.trim());
}

export function parseTopInAppStackFrame(stacktrace: string): string | null {
  if (stacktrace === '') {
    return null;
  }

  const lines = stacktrace.split('\n');
  for (const line of lines) {
    const frameMatch = line.match(FRAME_LINE_PATTERN);
    if (frameMatch === null) {
      continue;
    }

    const frameBody = frameMatch[1];
    if (frameBody === undefined) {
      continue;
    }

    const parenMatch = frameBody.match(PAREN_FRAME_PATTERN);
    let location: string | null = null;
    if (parenMatch !== null) {
      location = parenMatch[1] ?? null;
    } else if (BARE_LOCATION_PATTERN.test(frameBody.trim())) {
      location = frameBody.trim();
    }

    if (location === null) {
      continue;
    }

    if (!isInAppFrame(location)) {
      continue;
    }

    return normalizeFrameLocation(location);
  }

  return null;
}
