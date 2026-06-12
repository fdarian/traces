export function Duration(props: { readonly ms: number }) {
  const value =
    props.ms >= 1000
      ? { number: (props.ms / 1000).toFixed(2), unit: 's' }
      : { number: Math.round(props.ms).toString(), unit: 'ms' };

  return (
    <span className="font-data text-[12px]">
      <span className="text-[var(--text-primary)]">{value.number}</span>
      <span className="text-[var(--text-tertiary)]">{value.unit}</span>
    </span>
  );
}
