import { defineConfig } from 'blume';
import { posthog } from 'blume/analytics';

const ph = process.env.POSTHOG_KEY;

export default defineConfig({
  title: 'traces',
  ...(ph ? { analytics: [posthog({ key: ph })] } : {}),
  description:
    'A lightweight observability dashboard for Jaeger v2 with a publishable React SDK.',
  basePath: '/docs',
  theme: {
    accent: '#4d9fff',
    mode: 'dark',
    fonts: { display: 'geist', body: 'geist', mono: 'geist-mono' },
  },
});
