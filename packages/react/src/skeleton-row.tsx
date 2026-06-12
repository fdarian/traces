export function SkeletonRow(props: {
  readonly height?: number;
  readonly className?: string;
}) {
  const height = props.height ?? 32;
  return (
    <div
      className={`relative overflow-hidden bg-bg-subtle ${props.className ?? ''}`}
      style={{ height }}
    >
      <div
        className="absolute inset-0 animate-shimmer"
        style={{
          backgroundImage:
            'linear-gradient(90deg, transparent, var(--bg-raised), transparent)',
          backgroundSize: '200% 100%',
        }}
      />
    </div>
  );
}
