import type { ReactNode } from 'react';

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
      <p className="text-[13px] text-[var(--text-secondary)]">
        {props.message}
      </p>
      {props.action !== undefined && (
        <div className="text-[13px] text-[var(--accent)]">{props.action}</div>
      )}
    </div>
  );
}
