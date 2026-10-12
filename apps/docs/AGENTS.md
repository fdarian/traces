# @traces/docs

[Blume](https://useblume.dev) documentation site — covers the app + the React SDK. Served under `/docs`; the landing page is `pages/index.astro`.

## Stack
- Blume (Astro-based), React islands

## Dev
- `pnpm dev` — start dev server
- `pnpm build` — static build to `dist/`
- `pnpm check:validate` — strict link check
- `pnpm check:tsc` — typecheck
- `pnpm check:lint` — lint

## Architecture
- `docs/` — MDX content; sidebar order lives in each folder's `meta.ts`
- `islands/` — React components usable in MDX without imports; filename (PascalCase) is the tag name, default export required. Props from MDX must be serializable, so live examples wrap SDK components with fixed fixtures
- `fixtures/` — sample data for the live examples
- `theme.css` — design token overrides and `@traces/react/theme.css`
- `blume.config.ts` — site title, `basePath`, theme
