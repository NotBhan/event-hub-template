import { defineConfig } from 'drizzle-kit';
import { loadEnvFile } from './src/lib/security/env-file';

loadEnvFile();

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error('Set DATABASE_MIGRATION_URL or DATABASE_URL before running drizzle-kit');
}

/**
 * Migrations run as the schema-owning account, never as the runtime account.
 * `strict` and `verbose` make generation stop and ask before destructive output.
 */
export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
