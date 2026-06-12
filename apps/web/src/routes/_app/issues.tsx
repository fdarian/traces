import { createFileRoute } from '@tanstack/react-router';
import { EmptyState } from '@traces/react';

export const Route = createFileRoute('/_app/issues')({
  component: IssuesPage,
});

function IssuesPage() {
  return (
    <div className="px-4 py-6">
      <EmptyState message="issues page coming in a later issue" />
    </div>
  );
}
