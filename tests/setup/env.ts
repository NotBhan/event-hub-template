/**
 * Test environment.
 *
 * Points the application at a dedicated test database before any module reads
 * configuration. This file runs before each test file, and the global setup has
 * already created and migrated that database by then.
 */
import { loadEnvFile } from '../../src/lib/security/env-file';

loadEnvFile();

const TEST_DATABASE = process.env.TEST_DATABASE_NAME ?? 'event_platform_test';
const base = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '';

if (!base) {
  throw new Error('DATABASE_URL must be set to run the test suite (see .env.example)');
}

// Swap the database name, keeping the credentials and host from the real config.
const testUrl = base.replace(/\/[^/?]+(\?|$)/, `/${TEST_DATABASE}$1`);

process.env.DATABASE_URL = testUrl;
process.env.DATABASE_MIGRATION_URL = testUrl;

// Never let a test believe it is running in production.
process.env.NODE_ENV = 'test';

// Keep the simulated provider regardless of what the local .env says, so a
// checkout test can never reach a real gateway.
process.env.PAYMENT_PROVIDER = 'simulated';

// Email goes to the console transport; assertions read the outbox table.
process.env.EMAIL_PROVIDER = 'console';
