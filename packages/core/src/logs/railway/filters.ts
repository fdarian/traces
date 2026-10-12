import type { LogLevel } from '../model.js';

export const levelFilter = (
  levels: ReadonlyArray<LogLevel>,
): string | undefined => {
  const native = new Set<string>();
  for (const level of levels) {
    if (level === 'fatal') native.add('error');
    else if (level !== 'unknown') native.add(level);
  }
  if (native.size === 0) return undefined;
  const terms = [...native].map((level) => `@level:${level}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
};

export const grepFilter = (grep: string | undefined): string | undefined =>
  grep === undefined
    ? undefined
    : `"${grep.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export const joinFilter = (
  parts: ReadonlyArray<string | undefined>,
): string | undefined => {
  const present = parts.filter((part) => part !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
};

export const httpStatusFilter = (levels: ReadonlyArray<LogLevel>) => {
  if (levels.length === 0 || levels.includes('info')) return undefined;
  return levels.includes('warn') ? '@httpStatus:>=400' : '@httpStatus:>=500';
};
