import { defineConfig } from 'blume';

export default defineConfig({
  title: 'traces',
  description:
    'A lightweight observability dashboard for Jaeger v2 with a publishable React SDK.',
  basePath: '/docs',
  theme: {
    accent: '#4d9fff',
    mode: 'dark',
    fonts: { display: 'geist', body: 'geist', mono: 'geist-mono' },
  },
});
