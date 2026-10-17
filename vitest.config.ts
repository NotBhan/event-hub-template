import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Test configuration.
 *
 * Integration and security tests run against a real PostgreSQL database rather
 * than a mock. The behaviours this platform has to get right — row locking,
 * unique constraints, the partial index that admits a ticket once — only exist in
 * the database, so a mocked test would prove nothing.
 *
 * The database is a separate one from development, created and migrated by the
 * global setup, so running the suite never touches working data.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Playwright drives the browser tests; Vitest must not pick them up.
    exclude: ['tests/e2e/**', 'node_modules/**'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/env.ts'],
    /**
     * Database tests share one connection pool and one database, so test files run
     * sequentially. Parallel files would contend for the same rows and make
     * failures depend on scheduling.
     */
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
