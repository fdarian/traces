import { createFileRoute } from '@tanstack/react-router';
import {
  Duration,
  EmptyState,
  ServiceBadge,
  SkeletonRow,
  StatusBadge,
} from '@traces/react';

export const Route = createFileRoute('/_app/token-showcase')({
  component: TokenShowcase,
});

function TokenShowcase() {
  return (
    <div className="flex flex-col gap-8 px-4 py-6">
      {/* Surfaces */}
      <Section title="surfaces">
        <div className="flex gap-4">
          <SurfaceSwatch name="bg-base" color="var(--bg-base)" />
          <SurfaceSwatch name="bg-subtle" color="var(--bg-subtle)" />
          <SurfaceSwatch name="bg-raised" color="var(--bg-raised)" />
          <SurfaceSwatch name="bg-inset" color="var(--bg-inset)" />
        </div>
      </Section>

      {/* Text */}
      <Section title="text">
        <div className="flex flex-col gap-2">
          <TextSample color="var(--text-primary)" label="text-primary" />
          <TextSample color="var(--text-secondary)" label="text-secondary" />
          <TextSample color="var(--text-tertiary)" label="text-tertiary" />
        </div>
      </Section>

      {/* Accent */}
      <Section title="accent">
        <div className="flex gap-4">
          <SurfaceSwatch name="accent" color="var(--accent)" />
          <SurfaceSwatch name="accent-subtle" color="var(--accent-subtle)" />
        </div>
      </Section>

      {/* Status */}
      <Section title="status">
        <div className="flex flex-col gap-2">
          <StatusBadge status="error" />
          <StatusBadge status="warn" />
          <StatusBadge status="ok" />
          <StatusBadge status="resolved" />
          <StatusBadge status="neutral" />
        </div>
      </Section>

      {/* Borders */}
      <Section title="borders">
        <div className="flex gap-4">
          <SurfaceSwatch name="border-subtle" color="var(--border-subtle)" />
          <SurfaceSwatch name="border-default" color="var(--border-default)" />
          <SurfaceSwatch name="border-strong" color="var(--border-strong)" />
        </div>
      </Section>

      {/* Typography */}
      <Section title="typography">
        <div className="flex flex-col gap-2">
          <p className="text-[11px] uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
            11px uppercase label
          </p>
          <p className="font-data text-[12px] text-[var(--text-primary)]">
            12px data — 1,234,567.89
          </p>
          <p className="text-[13px] text-[var(--text-primary)]">
            13px body default
          </p>
          <p className="text-[14px] text-[var(--text-primary)]">
            14px section heading
          </p>
          <p className="text-[18px] font-semibold text-[var(--text-primary)]">
            18px page title
          </p>
        </div>
      </Section>

      {/* Primitives */}
      <Section title="primitives">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-secondary)]">
              Duration:
            </span>
            <Duration ms={142} />
            <Duration ms={1250} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-secondary)]">
              ServiceBadge:
            </span>
            <ServiceBadge name="web" />
            <ServiceBadge name="api" />
            <ServiceBadge name="payments" />
            <ServiceBadge name="db" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-secondary)]">
              SkeletonRow:
            </span>
          </div>
          <SkeletonRow className="w-64" />
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-secondary)]">
              EmptyState:
            </span>
          </div>
          <EmptyState message="no traces in this range" />
        </div>
      </Section>
    </div>
  );
}

function Section(props: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
        {props.title}
      </h2>
      {props.children}
    </div>
  );
}

function SurfaceSwatch(props: {
  readonly name: string;
  readonly color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="h-12 w-12 rounded border border-[var(--border-default)]"
        style={{ backgroundColor: props.color }}
      />
      <span className="text-[11px] text-[var(--text-tertiary)]">
        {props.name}
      </span>
    </div>
  );
}

function TextSample(props: { readonly color: string; readonly label: string }) {
  return (
    <span className="text-[13px]" style={{ color: props.color }}>
      {props.label}
    </span>
  );
}
