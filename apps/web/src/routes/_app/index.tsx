import { createFileRoute } from '@tanstack/react-router';
import { EmptyState } from '@traces/react';

export const Route = createFileRoute('/_app/')({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="px-4 py-6">
      <EmptyState message="home page coming in a later issue" />
    </div>
  );
}
