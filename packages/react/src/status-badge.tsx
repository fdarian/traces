export type Status = 'error' | 'warn' | 'ok' | 'resolved' | 'neutral';

const statusConfig: Record<
  Status,
  { readonly label: string; readonly dot: string; readonly bg: string }
> = {
  error: {
    label: 'error',
    dot: 'var(--status-error)',
    bg: 'var(--status-error-bg)',
  },
  warn: {
    label: 'warn',
    dot: 'var(--status-warn)',
    bg: 'var(--status-warn-bg)',
  },
  ok: {
    label: 'ok',
    dot: 'var(--status-ok)',
    bg: 'var(--status-ok-bg)',
  },
  resolved: {
    label: 'resolved',
    dot: 'var(--status-ok)',
    bg: 'var(--status-ok-bg)',
  },
  neutral: {
    label: 'neutral',
    dot: 'var(--status-neutral)',
    bg: 'rgba(92, 100, 112, 0.10)',
  },
};

/**
 * Pill badge with a colored dot that communicates a span or issue status.
 * Accepts an optional `label` override; otherwise renders the status name.
 *
 * @example
 * ```tsx
 * <StatusBadge status="error" />
 * <StatusBadge status="resolved" label="closed" />
 * ```
 */
export function StatusBadge(props: {
  readonly status: Status;
  readonly label?: string;
}) {
  const config = statusConfig[props.status];
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-label font-medium uppercase tracking-wide"
      style={{ backgroundColor: config.bg, color: config.dot }}
    >
      <span
        className="inline-block h-1 w-1 rounded-full"
        style={{ backgroundColor: config.dot }}
      />
      {props.label ?? config.label}
    </span>
  );
}
