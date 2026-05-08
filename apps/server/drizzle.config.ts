import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: '../../packages/core/src/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env['GAIDO_DB_FILE'] ?? './gaido.db',
  },
});
