import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/issues/drizzle/schema-pg.ts',
    './src/service-stats/drizzle/schema-pg.ts',
  ],
  out: './drizzle/pg',
  dialect: 'postgresql',
});
