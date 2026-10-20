# @traces/react

Publishable React SDK — controlled, presentational components that power the dashboard. The app (`apps/web`) is its first consumer, but all components are designed from day one to be consumed externally. No extraction later.

## Hard boundaries (load-bearing — these are WHY the structure is unusual)

- **No app coupling**: no `@tanstack/react-router`, no server-fn imports, no app path aliases (`#/*` only inside this package where tsconfig is configured for it). Components never assume a host router or server.
- **Navigation via callbacks only**: `onTraceClick`, `onSpanSelect`, `onResolve`, etc. The app provides all router glue.
- **No `'use client'`**: TanStack Start has no RSC — this directive is meaningless and never used anywhere in the repo.
- **`@traces/core` is type-only / devDependency only**: it is a workspace-only package — consumers can't install it. Do NOT `import ... from '@traces/core'` in any shippable source.
  - Core domain types are vendored into `src/types.ts`.
  - `src/types.guard.ts` is a compile-time assertion file (never imported by `index.ts`, never in the bundle) that fails `tsrs` if the local copy structurally diverges from `@traces/core`. If you add or change a core type: update `src/types.ts` AND add/update the corresponding `AssertEqual` line in `types.guard.ts`.

## Theming / token contract

- Components use Tailwind utilities generated from `src/styles.src.css`'s `@theme`, which maps to DESIGN.md CSS variables.
- The package ships `dist/theme.css` (exported as `@traces/react/theme.css`): self-contained compiled output containing `:root` dark token defaults, all utility rules, `.font-data`, shimmer keyframes, and waterfall animation.
- Consumers import `@traces/react/theme.css` and may override any `--token` variable. Token groups: surfaces (`--bg-*`), borders (`--border-*`), text (`--text-*`), accent (`--accent*`), status (`--status-*`).
- Consumers must supply Geist fonts themselves (`@fontsource-variable/geist` + `geist-mono`); `theme.css` sets font-family vars but bundles no font files.
- Tailwind is an internal build detail. Editing component classNames requires re-running `pnpm run build:css` (included in `pnpm run build`).

## Build / packaging

- `pnpm run build` = `tsup` (ESM + `.d.ts` → `dist/`) then `build:css` (`theme.css` → `dist/`).
- `dist/` is gitignored — never commit it; produced at publish/pack time.
- exports: `.` (types + import) and `./theme.css`. peerDeps: `react/react-dom >=19`. `publishConfig.access: public`. version `0.1.0`.
- Biome ignores `src/styles.src.css` (`packages/react/biome.jsonc`) — Tailwind v4 at-rules aren't valid plain CSS to Biome.

## SDK-vs-app boundary

Pure presentation and pure utils live HERE. Data fetching, server functions, routing, URL state, the issue store, and the Jaeger backend live in the APP. If a component needs data → prop. If it needs to navigate → callback.

## Dev commands

- `pnpm check:tsc` — typecheck
- `pnpm check:lint` — lint
- `bun test` — run tests
- `pnpm run build` — full build (tsup + theme.css)
