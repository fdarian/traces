/** Converts a nanosecond Unix timestamp (string or number) to milliseconds. */
export function normalizeTimestampToMs(value: string | number): number {
  const nanoStr = typeof value === 'string' ? value : value.toString();
  const nanos = BigInt(nanoStr);
  return Number(nanos / BigInt(1000000));
}
