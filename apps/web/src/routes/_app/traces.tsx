import { createFileRoute } from '@tanstack/react-router';
import { EmptyState } from '@traces/react';

export const Route = createFileRoute('/_app/traces')({
  component: TracesPage,
});

function TracesPage() {
  return (
    <div className="px-4 py-6">
      <EmptyState message="traces page coming in a later issue" />
    </div>
  );
}
