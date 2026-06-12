/**
 * Animated shimmer placeholder row used during loading states in list tables.
 * Defaults to 32 px height; pass `height` or `className` to adapt to context.
 *
 * @example
 * ```tsx
 * {isLoading && Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)}
 * ```
 */
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
