import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/issues/drizzle/schema-sqlite.ts'],
  out: './drizzle/sqlite',
  dialect: 'sqlite',
});
