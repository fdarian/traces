import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0B0D10]">
      <div className="text-center">
        <h1 className="font-sans text-2xl font-semibold text-[#E6E9EF]">
          traces
        </h1>
        <p className="mt-2 font-mono text-sm text-[#9BA3B0]">
          lightweight observability dashboard
        </p>
      </div>
    </div>
  );
}
