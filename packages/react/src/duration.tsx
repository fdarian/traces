/**
 * Formats a duration in milliseconds as a human-readable value with a
 * de-emphasized unit suffix — renders `ms` below 1 s, `s` above.
 *
 * @example
 * ```tsx
 * <Duration ms={span.durationMs} />
 * ```
 */
export function Duration(props: { readonly ms: number }) {
  const value =
    props.ms >= 1000
      ? { number: (props.ms / 1000).toFixed(2), unit: 's' }
      : { number: Math.round(props.ms).toString(), unit: 'ms' };

  return (
    <span className="font-data text-data">
      <span className="text-text-primary">{value.number}</span>
      <span className="text-text-tertiary">{value.unit}</span>
    </span>
  );
}
