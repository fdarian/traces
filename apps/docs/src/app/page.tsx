import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col bg-bg-base">
      {/* nav bar */}
      <header className="flex h-10 items-center border-b border-border-subtle px-6">
        <span className="text-sm font-medium text-text-primary tracking-tight">
          traces
        </span>
        <nav className="ml-auto flex items-center gap-4">
          <Link
            href="/docs"
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            docs
          </Link>
          <a
            href="https://github.com"
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            github
          </a>
        </nav>
      </header>

      {/* hero */}
      <section className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <div className="mb-3 inline-flex items-center gap-1.5 rounded border border-border-default bg-bg-subtle px-2.5 py-1 text-xs text-text-tertiary uppercase tracking-widest">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-ok" />
          open source · jaeger v2
        </div>

        <h1 className="mt-6 max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-text-primary">
          a dark instrument panel
          <br />
          <span className="text-text-secondary">for distributed traces</span>
        </h1>

        <p className="mt-4 max-w-lg text-sm leading-relaxed text-text-secondary">
          point it at an existing jaeger v2 and get a home overview, trace
          exploration, error aggregation, and per-service filtering — built on a
          publishable react sdk.
        </p>

        <div className="mt-8 flex items-center gap-3">
          <Link
            href="/docs"
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-bg-base hover:opacity-90 transition-opacity"
          >
            get started
          </Link>
          <Link
            href="/docs/sdk/getting-started"
            className="rounded border border-border-default bg-bg-subtle px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-raised transition-colors"
          >
            sdk docs
          </Link>
        </div>
      </section>

      {/* feature grid */}
      <section className="border-t border-border-subtle">
        <div className="grid grid-cols-1 divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="px-8 py-10">
            <div className="mb-2 text-xs uppercase tracking-widest text-text-tertiary">
              app
            </div>
            <h3 className="text-sm font-medium text-text-primary">
              dashboard first
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              home overview, trace list, error aggregation. density is the
              feature — maximum signal per screen.
            </p>
          </div>
          <div className="px-8 py-10">
            <div className="mb-2 text-xs uppercase tracking-widest text-text-tertiary">
              sdk
            </div>
            <h3 className="text-sm font-medium text-text-primary">
              @traces/react
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              publishable component sdk — waterfall, trace detail, issue list,
              and more. bring your own router.
            </p>
          </div>
          <div className="px-8 py-10">
            <div className="mb-2 text-xs uppercase tracking-widest text-text-tertiary">
              design
            </div>
            <h3 className="text-sm font-medium text-text-primary">
              token-driven theming
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              css variable tokens for surfaces, borders, text, accent, and
              status. override any token to match your brand.
            </p>
          </div>
        </div>
      </section>

      <footer className="flex h-10 items-center border-t border-border-subtle px-6">
        <span className="text-xs text-text-tertiary">traces — mit license</span>
      </footer>
    </main>
  );
}
