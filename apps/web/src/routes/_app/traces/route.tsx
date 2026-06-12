import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/traces')({
  component: TracesLayout,
});

function TracesLayout() {
  return <Outlet />;
}
