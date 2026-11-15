import {
  createFileRoute,
  Link,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import * as S from 'effect/Schema';
import { Activity, Home, Layers } from 'lucide-react';
import { engine } from '#/lib/engine-client';
import { GlobalFilterSchema, normalizeGlobalFilters } from '#/lib/filters';

export const Route = createFileRoute('/_app')({
  validateSearch: S.toStandardSchemaV1(GlobalFilterSchema),
  component: AppLayout,
  loader: async () => {
    try {
      const services = await engine.traces.listServices();
      return { services, error: null as null | Error };
    } catch (err) {
      return {
        services: [] as ReadonlyArray<string>,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  },
});

const navItems = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/traces', label: 'Traces', icon: Layers },
  { to: '/issues', label: 'Issues', icon: Activity },
];

function AppLayout() {
  const loaderData = Route.useLoaderData();

  return (
    <div className="flex min-h-screen">
      {/* left nav */}
      <nav className="fixed left-0 top-0 h-full w-52 border-r border-border-default bg-bg-base">
        <div className="flex h-10 items-center px-4">
          <span className="text-body font-semibold text-text-primary">
            traces
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-0.5 px-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === '/' }}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-body text-text-secondary transition-colors duration-120 ease-out hover:bg-bg-raised hover:text-text-primary [&.active]:bg-accent-subtle [&.active]:text-accent"
              >
                <Icon size={14} strokeWidth={1.5} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* main area */}
      <div className="ml-52 flex min-h-screen flex-1 flex-col">
        {/* sticky top bar */}
        <div className="sticky top-0 z-10 flex h-10 items-center gap-3 border-b border-border-default bg-bg-base px-4">
          <GlobalFilters
            services={loaderData.services}
            error={loaderData.error}
          />
        </div>

        {/* content */}
        <main className="flex-1">
          {loaderData.error !== null ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-12">
              <p className="text-body text-status-error">jaeger unreachable</p>
              <p className="font-data text-data text-text-tertiary">
                {loaderData.error.message}
              </p>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}

function GlobalFilters(props: {
  readonly services: ReadonlyArray<string>;
  readonly error: Error | null;
}) {
  const router = useRouter();
  const search = router.state.location.search as Record<string, unknown>;
  const filters = normalizeGlobalFilters(search);

  const handleServiceToggle = (service: string) => {
    const next = new Set(filters.service);
    if (next.has(service)) {
      next.delete(service);
    } else {
      next.add(service);
    }
    router.navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        service: Array.from(next),
      }),
    } as Record<string, unknown>);
  };

  const handleRangeChange = (range: '15m' | '1h' | '6h' | '24h' | '7d') => {
    router.navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        range,
        from: undefined,
        to: undefined,
      }),
    } as Record<string, unknown>);
  };

  const presets = ['15m', '1h', '6h', '24h', '7d'] as const;

  return (
    <div className="flex items-center gap-3">
      <span className="text-label uppercase tracking-wide text-text-tertiary">
        filters
      </span>

      {/* service picker */}
      <div className="flex items-center gap-1">
        {props.error === null &&
          props.services.map((service) => {
            const active = filters.service.includes(service);
            return (
              <button
                key={service}
                type="button"
                onClick={() => handleServiceToggle(service)}
                className={`rounded px-1.5 py-0.5 text-label font-medium uppercase tracking-wide transition-colors duration-120 ease-out ${
                  active
                    ? 'bg-accent-subtle text-accent'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {service}
              </button>
            );
          })}
      </div>

      {/* range picker */}
      <div className="flex items-center gap-1">
        {presets.map((preset) => {
          const active =
            typeof filters.range === 'string' && filters.range === preset;
          return (
            <button
              key={preset}
              type="button"
              onClick={() => handleRangeChange(preset)}
              className={`rounded px-1.5 py-0.5 text-label font-medium uppercase tracking-wide transition-colors duration-120 ease-out ${
                active
                  ? 'bg-accent-subtle text-accent'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {preset}
            </button>
          );
        })}
      </div>
    </div>
  );
}
