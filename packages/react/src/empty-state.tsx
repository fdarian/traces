import type { ReactNode } from 'react';

/**
 * Centered placeholder with a dot-grid background for empty list states.
 * Accepts an optional `action` node (e.g. a link or button) rendered below
 * the message.
 *
 * @example
 * ```tsx
 * <EmptyState
 *   message="no traces in this range"
 *   action={<a href="/settings">configure data source</a>}
 * />
 * ```
 */
export function EmptyState(props: {
  readonly message: string;
  readonly action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-4 py-12"
      style={{
        backgroundImage:
          'radial-gradient(circle, var(--border-subtle) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
      }}
    >
      <p className="text-body text-text-secondary">{props.message}</p>
      {props.action !== undefined && (
        <div className="text-body text-accent">{props.action}</div>
      )}
    </div>
  );
}
