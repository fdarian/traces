/**
 * formats a past epoch-millis timestamp as a compact relative string (`42s ago`, `3h ago`, `5d ago`).
 *
 * @example
 * ```ts
 * relativeTime(Date.now() - 3_600_000); // "1h ago"
 * ```
 */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
