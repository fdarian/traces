import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/issues')({
  component: IssuesLayout,
});

function IssuesLayout() {
  return <Outlet />;
}
